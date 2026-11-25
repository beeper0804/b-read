"""Local Sign in with ChatGPT for B-read."""
import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import tempfile
from threading import RLock
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener
import uuid

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
AUTHORIZE = ISSUER + "/api/accounts/authorize"
TOKEN = ISSUER + "/api/accounts/oauth/token"
DISCOVERY = ISSUER + "/.well-known/openid-configuration"
JWKS = ISSUER + "/.well-known/jwks.json"
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
REQUIRED = {"resource.invoke", "chatgpt.tokens.use.direct"}
REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max"}
PREFERRED_MODELS = ("gpt-6.1-terra", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-5.4-mini", "gpt-5.4")
EXPIRED = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
           "refresh_token_invalidated", "refresh_token_reused"}
NAME = "B-read"


class PlanError(Exception):
    def __init__(self, message, code=""):
        super().__init__(message)
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def open_request(url, *, token=None, form=None, body=None, stream=False):
    headers = {"Accept": "text/event-stream" if stream else "application/json"}
    data = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        data = urlencode(form).encode("ascii")
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    return build_opener(NoRedirect()).open(Request(url, data=data, headers=headers), timeout=60)


def load_json(url, **kwargs):
    with open_request(url, **kwargs) as response:
        return json.load(response)


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode64(text):
    return base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)


def validate_id_token(value, client, nonce, keys):
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils

    try:
        head, payload, signature = value.split(".")
        header, claims = json.loads(decode64(head)), json.loads(decode64(payload))
        algorithm = header.get("alg")
        if algorithm not in {"RS256", "ES256"} or not header.get("kid"):
            raise ValueError
        kty = "RSA" if algorithm == "RS256" else "EC"
        key, = (key for key in keys["keys"]
                if key.get("kid") == header["kid"] and key.get("kty") == kty
                and key.get("use", "sig") == "sig" and key.get("alg", algorithm) == algorithm)
        sig = decode64(signature)
        message = (head + "." + payload).encode("ascii")
        if algorithm == "RS256":
            n = int.from_bytes(decode64(key["n"]), "big")
            e = int.from_bytes(decode64(key["e"]), "big")
            if n.bit_length() < 2048:
                raise ValueError
            rsa.RSAPublicNumbers(e, n).public_key().verify(sig, message, padding.PKCS1v15(), hashes.SHA256())
        else:
            if key.get("crv") != "P-256" or len(sig) != 64:
                raise ValueError
            x = int.from_bytes(decode64(key["x"]), "big")
            y = int.from_bytes(decode64(key["y"]), "big")
            der = utils.encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
            ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key().verify(der, message, ec.ECDSA(hashes.SHA256()))
        audience = claims.get("aud")
        if isinstance(audience, str):
            audience = [audience]
        if (claims.get("iss") != ISSUER or not isinstance(audience,list) or client not in audience
                or (len(audience) > 1 and claims.get("azp") != client)
                or claims.get("azp",client) != client or type(claims.get("exp")) is not int
                or claims["exp"] <= time.time() or claims.get("nonce") != nonce
                or not isinstance(claims.get("sub"),str) or not claims["sub"]):
            raise ValueError
    except (InvalidSignature, AttributeError, ValueError, KeyError, TypeError) as exc:
        raise PlanError("无法验证 OpenAI 返回的身份，请重新登录。", "identity_invalid") from exc
    return claims


def dpapi(data, decrypt=False):
    import ctypes as c
    from ctypes import wintypes as w

    class Blob(c.Structure):
        _fields_ = [("size",w.DWORD),("data",c.POINTER(c.c_ubyte))]

    buffer = (c.c_ubyte * len(data)).from_buffer_copy(data)
    incoming = Blob(len(data),buffer)
    outgoing = Blob()
    crypt = c.WinDLL("crypt32",use_last_error=True)
    kernel = c.WinDLL("kernel32",use_last_error=True)
    kernel.LocalFree.argtypes = [c.c_void_p]
    kernel.LocalFree.restype = c.c_void_p
    func = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    func.argtypes = [c.POINTER(Blob),c.c_void_p,c.c_void_p,c.c_void_p,c.c_void_p,w.DWORD,c.POINTER(Blob)]
    func.restype = w.BOOL
    if not func(c.byref(incoming),None,None,None,None,1,c.byref(outgoing)):
        raise OSError("Windows could not open the protected connection record")
    try:
        return c.string_at(outgoing.data,outgoing.size)
    finally:
        kernel.LocalFree(outgoing.data)


class LocalVault:
    def __init__(self):
        if os.name == "nt":
            root = Path(os.environ.get("LOCALAPPDATA",str(Path.home() / "AppData" / "Local")))
        else:
            root = Path(os.environ.get("XDG_CONFIG_HOME",str(Path.home() / ".config")))
        self.path = root / "ReadingDictionary" / "chatgpt-plan"

    def read(self):
        try:
            raw = self.path.read_bytes()
            return json.loads(dpapi(raw,True) if os.name == "nt" else raw)
        except FileNotFoundError:
            return {"host":"urn:uuid:"+str(uuid.uuid4()),"accounts":{},"active":None}

    def write(self, value):
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        raw = json.dumps(value,ensure_ascii=False).encode("utf-8")
        if os.name == "nt":
            raw = dpapi(raw)
        fd, name = tempfile.mkstemp(dir=self.path.parent,prefix=".chatgpt-")
        try:
            with os.fdopen(fd,"wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name,self.path)
        finally:
            Path(name).unlink(missing_ok=True)


def stream_answer(response):
    parts = []
    for raw in response:
        if not raw.startswith(b"data:"):
            continue
        content = raw[5:].strip()
        if not content or content == b"[DONE]":
            continue
        event = json.loads(content)
        kind = event.get("type")
        if kind == "response.output_text.delta":
            parts.append(event.get("delta",""))
        elif kind == "response.completed":
            answer = "".join(parts).strip()
            if not answer:
                raise PlanError("模型没有返回可显示的讲解。")
            return answer
        elif kind in ("error","response.failed","response.incomplete"):
            err = event.get("response",{}).get("error") or event.get("error") or event
            raise upstream_error(err.get("code",""))
    raise PlanError("讲解未完整返回，请重试。")


def upstream_error(code, http=None):
    if code == "subscription_sharing_usage_limit_exceeded" or http == 429:
        return PlanError("已达到 ChatGPT 套餐或此扩展的用量上限。请查看「管理用量」。", "usage_limit")
    if code == "subscription_sharing_user_not_eligible":
        return PlanError("当前 ChatGPT 账号或工作区不具备套餐共享权限。", code)
    if code in EXPIRED or http == 401:
        return PlanError("ChatGPT 会话需要重新授权。", "signin_required")
    if http == 403:
        return PlanError("OpenAI 当前拒绝这项套餐请求。请核对所选账号和授权。", "plan_unavailable")
    if http == 503:
        return PlanError("ChatGPT 套餐服务暂时不可用，请稍后重试。")
    suffix = f"（HTTP {http}）" if http else ""
    return PlanError("OpenAI 无法完成本次请求" + suffix + "。")


def error_code(error):
    try:
        value = json.loads(error.read(64 * 1024))
        if isinstance(value.get("error"),dict):
            return value["error"].get("code","")
        return value.get("error","")
    except (OSError, ValueError, AttributeError):
        return ""


@dataclass
class Attempt:
    state: str
    nonce: str
    verifier: str
    account: str | None
    expires: float


class PlanConnection:
    def __init__(self, redirect_uri, vault=None, request=load_json, streaming=open_request):
        self.redirect_uri = redirect_uri
        self.vault = vault or LocalVault()
        self.read_json = request
        self.streaming = streaming
        self.saved = self.vault.read()
        self.lock = RLock()
        self.pending = None
        self.feedback = ""
        self.model_cache = {}

    def account(self):
        return self.saved["accounts"].get(self.saved["active"])

    def status(self):
        with self.lock:
            active = self.account() or {}
            return {
                "mode":"plan", "ready":bool(active.get("access") and REQUIRED.issubset(active["scopes"])),
                "account":active.get("label",""), "active":self.saved["active"], "feedback":self.feedback,
                "accounts":[{"id":k,"label":r["label"]} for k,r in self.saved["accounts"].items()],
            }

    def start(self, client=None):
        with self.lock:
            if client is not None and (not isinstance(client,str) or client not in self.saved["accounts"]):
                raise PlanError("请选择要重新连接的 ChatGPT 账号。")
            self.vault.write(self.saved)
            self.pending = attempt = Attempt(secrets.token_urlsafe(32),secrets.token_urlsafe(32),
                                             secrets.token_urlsafe(64),client,time.monotonic()+600)
            self.feedback = "等待在 OpenAI 页面完成授权。"
            params = dict(client_id=client or "dynamic_agent_client",ext_agent_host_id=self.saved["host"],
                          response_type="code",redirect_uri=self.redirect_uri,scope=SCOPE,resource=RESOURCE,
                          state=attempt.state,nonce=attempt.nonce,code_challenge_method="S256",
                          code_challenge=b64(hashlib.sha256(attempt.verifier.encode("ascii")).digest()))
            if client:
                record = self.saved["accounts"][client]
                if not REQUIRED.issubset(record.get("scopes",[])):
                    params["prompt"] = "consent"
            else:
                params["agent_name_hint"] = NAME
            return AUTHORIZE + "?" + urlencode(params)

    def finish(self, query):
        try:
            fields = parse_qs(query,keep_blank_values=True,max_num_fields=16)
            if any(len(values) != 1 for values in fields.values()):
                raise ValueError
            params = {k:values[0] for k,values in fields.items()}
        except ValueError as exc:
            raise PlanError("登录回调格式无效。") from exc
        with self.lock:
            attempt = self.pending
            if not attempt or time.monotonic() > attempt.expires or not hmac.compare_digest(
                    params.get("state","").encode("utf-8"),attempt.state.encode("ascii")):
                raise PlanError("登录链接已过期或无法核验，请从扩展重新开启。")
            self.pending = None
            try:
                if params.get("error"):
                    raise PlanError("ChatGPT 授权未完成。你可以回到扩展重试。")
                client = params.get("client_id") or attempt.account
                if not client or not client.startswith("oaiapp_") or attempt.account not in (None,client) or not params.get("code"):
                    raise PlanError("OpenAI 返回的客户端登记信息不完整。")
                tokens = self.read_json(TOKEN,form=dict(grant_type="authorization_code",client_id=client,
                    code=params["code"],code_verifier=attempt.verifier,redirect_uri=self.redirect_uri,resource=RESOURCE))
                claims = validate_id_token(tokens.get("id_token",""),client,attempt.nonce,self.read_json(JWKS))
                previous = self.saved["accounts"].get(client)
                if previous and previous["sub"] != claims["sub"]:
                    raise PlanError("登录账号与此连接的账号不一致。")
                email = claims.get("email") or claims.get("name") or "ChatGPT"
                record = {"sub":claims["sub"],"label":f"{email} · {client[-6:]}","identity":tokens["id_token"]}
                self.install_tokens(record,tokens)
                if REQUIRED.issubset(record["scopes"]) and not record["access"]:
                    raise PlanError("OpenAI 没有返回可用的套餐访问凭据。")
                next_record = {**self.saved,"active":client,"accounts":{**self.saved["accounts"],client:record}}
                self.vault.write(next_record)
                self.saved = next_record
                self.model_cache.pop(client,None)
                self.feedback = ("已连接，精读将使用你的 ChatGPT 套餐额度。" if REQUIRED.issubset(record["scopes"])
                                 else "已登录 ChatGPT。要使用套餐额度，请再次连接并同意额度授权。")
                return self.feedback
            except HTTPError as exc:
                self.feedback = "OpenAI 未能完成登录。请从扩展重新开始授权。"
                raise PlanError(self.feedback) from exc
            except PlanError as exc:
                self.feedback = str(exc)
                raise
            except (OSError,ValueError,TypeError,ImportError) as exc:
                self.feedback = "本地助手无法完成登录。请检查网络和 Python 依赖。"
                raise PlanError(self.feedback) from exc

    @staticmethod
    def install_tokens(record, tokens):
        scopes = tokens.get("scope","").split()
        record.update(scopes=scopes,access=tokens.get("access_token",""),refresh=tokens.get("refresh_token",""),
                      expiry=time.time()+int(tokens.get("expires_in",3600)))

    def clear_active(self, client, record):
        clean = {k:record[k] for k in ("sub","label")}
        current = {**self.saved,"accounts":{**self.saved["accounts"],client:clean},"active":None}
        self.vault.write(current)
        self.saved = current
        self.model_cache.pop(client,None)

    def logout(self):
        with self.lock:
            self.pending = None
            record = self.account()
            if not record:
                return "当前没有登录的 ChatGPT 连接。"
            client = self.saved["active"]
            unconfirmed = False
            if record.get("refresh"):
                try:
                    endpoint = self.read_json(DISCOVERY).get("revocation_endpoint","")
                    url = urlsplit(endpoint)
                    if url.scheme != "https" or url.netloc != "auth.openai.com" or not url.path.startswith("/"):
                        raise ValueError
                    with self.streaming(endpoint,form=dict(token=record["refresh"],token_type_hint="refresh_token",client_id=client)):
                        pass
                except (OSError, ValueError):
                    unconfirmed = True
            self.clear_active(client,record)
            self.feedback = ("已在本机退出。联网撤销未确认，可在 ChatGPT 的连接设置中断开。" if unconfirmed
                             else "已退出 ChatGPT 连接。")
            return self.feedback

    def access_token(self):
        with self.lock:
            client, record = self.saved["active"], self.account()
            if not record or not record.get("access") or not REQUIRED.issubset(record.get("scopes",[])):
                raise PlanError("请在设置中使用 ChatGPT 登录并允许使用套餐额度。", "signin_required")
            if record["expiry"] <= time.time()+60:
                if not record.get("refresh"):
                    raise PlanError("ChatGPT 会话已过期，请重新登录。", "signin_required")
                try:
                    updated = self.read_json(TOKEN,form=dict(grant_type="refresh_token",client_id=client,
                                                            refresh_token=record["refresh"],resource=RESOURCE))
                except HTTPError as exc:
                    code = error_code(exc)
                    if code in EXPIRED:
                        self.clear_active(client,record)
                    raise upstream_error(code,exc.code) from exc
                if not updated.get("access_token") or not updated.get("refresh_token"):
                    raise PlanError("OpenAI 返回的会话续期信息不完整。请重新登录。", "signin_required")
                if "scope" not in updated:
                    updated["scope"] = " ".join(record["scopes"])
                record = dict(record)
                self.install_tokens(record,updated)
                current = {**self.saved,"accounts":{**self.saved["accounts"],client:record}}
                self.vault.write(current)
                self.saved = current
                if not REQUIRED.issubset(record["scopes"]):
                    raise PlanError("会话未授予 ChatGPT 套餐权限。请重新连接。","signin_required")
            return record["access"]

    def available_models(self, token):
        with self.lock:
            client = self.saved["active"]
            cached = self.model_cache.get(client)
            if cached is None or cached[0] < time.monotonic():
                catalog = self.read_json(RESOURCE+"/models",token=token)
                models = {}
                for value in catalog.get("models", []):
                    slug = value.get("slug")
                    if not isinstance(slug, str) or not slug or value.get("visibility") != "list":
                        continue
                    name = value.get("display_name")
                    models[slug] = {"slug": slug, "name": name if isinstance(name, str) and name else slug}
                if not models:
                    raise PlanError("当前账号没有可用于精读的模型。")
                cached = self.model_cache[client] = (time.monotonic()+300,models)
            return cached[1]

    def reading_models(self):
        try:
            with self.lock:
                models = self.available_models(self.access_token())
                default = next((slug for slug in PREFERRED_MODELS if slug in models), next(iter(models)))
                return {"models": list(models.values()), "default": default}
        except HTTPError as exc:
            raise upstream_error(error_code(exc), exc.code) from exc

    def explain(self, instructions, text, context, *, model="", effort="", output_format=None, turns=()):
        try:
            with self.lock:
                token = self.access_token()
                models = self.available_models(token)
            slug = model or next((slug for slug in PREFERRED_MODELS if slug in models), next(iter(models)))
            if slug not in models:
                raise PlanError("所选模型当前对这个 ChatGPT 账号不可用，请在精读设置中重新选择。", "model_unavailable")
            if effort and effort not in REASONING_EFFORTS:
                raise ValueError("Invalid reasoning effort")
            payload = {"model":slug,"instructions":instructions,"store":False,"stream":True,
                       "input":[{"role":"user","content":json.dumps({"excerpt":text,"context":context},ensure_ascii=False)}]}
            payload["input"].extend(turns)
            if effort:
                payload["reasoning"] = {"effort": effort}
            if output_format:
                payload["text"] = {"format": output_format}
            with self.streaming(RESOURCE+"/responses",token=token,body=payload,stream=True) as response:
                result = stream_answer(response)
            return {"answer": result, "model": models[slug]["name"], "effort": effort} if output_format else result
        except HTTPError as exc:
            code = error_code(exc)
            if exc.code == 400 and effort and code in ("unsupported_value", "invalid_value", "unsupported_parameter"):
                raise PlanError("当前模型可能不支持此推理强度。请换一个强度，或选「模型默认」。", "reasoning_unavailable") from exc
            if code == "model_not_found" or exc.code == 404:
                raise PlanError("所选模型暂时不可用，请在精读设置中重新选择。", "model_unavailable") from exc
            raise upstream_error(code,exc.code) from exc

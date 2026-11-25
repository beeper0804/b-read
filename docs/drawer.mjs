import { storage } from "./web-platform.mjs";
const WIDTH_KEY = "reader-drawer-width";
const MAX_WIDTH = 720;
const MIN_WIDTH = 280;
const STEP = 24;

export function mountDrawer({root,bar,panel,toggle,handle}) {
  const desktop = window.matchMedia("(min-width: 940px)");
  let preferred;
  let width;
  let open = false;
  let drag;
  let changed = false;

  function bounds() {
    const viewport = root.clientWidth;
    const max = Math.max(1,Math.min(MAX_WIDTH,viewport - (desktop.matches ? 320 : 12)));
    return {min:Math.min(MIN_WIDTH,max), max};
  }

  function layout(value = preferred) {
    const {min,max} = bounds();
    const initial = desktop.matches ? Math.min(460,Math.max(320,root.clientWidth * .3)) : 390;
    width = Math.round(Math.max(min,Math.min(max,value ?? initial)));
    root.style.setProperty("--drawer-width",`${width}px`);
    handle.setAttribute("aria-valuemin",String(min));
    handle.setAttribute("aria-valuemax",String(max));
    handle.setAttribute("aria-valuenow",String(width));
    handle.setAttribute("aria-valuetext",`${width} 像素`);
  }

  function saveWidth() {
    changed = true;
    preferred = width;
    void storage.local.set({[WIDTH_KEY]:preferred}).catch(()=>{});
  }

  function setOpen(next) {
    if (open === next) return;
    open = next;
    if (!open && panel.contains(document.activeElement)) toggle.focus();
    panel.inert = !open;
    panel.setAttribute("aria-hidden",String(!open));
    toggle.setAttribute("aria-expanded",String(open));
    root.classList.toggle("drawer-open",open);
  }

  toggle.addEventListener("click",()=>setOpen(!open));
  handle.addEventListener("keydown",event=>{
    const {min,max} = bounds();
    const next = {ArrowLeft:width+STEP,ArrowRight:width-STEP,Home:min,End:max};
    if (!Object.hasOwn(next,event.key)) return;
    event.preventDefault();
    layout(next[event.key]);
    saveWidth();
  });
  handle.addEventListener("pointerdown",event=>{
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({preventScroll:true});
    handle.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId, x:event.clientX, width};
    root.classList.add("drawer-resizing");
  });
  handle.addEventListener("pointermove",event=>{
    if (drag?.id === event.pointerId) layout(drag.width + drag.x - event.clientX);
  });
  function endDrag(event) {
    if (drag?.id !== event.pointerId) return;
    if (event.type === "pointerup") {
      layout(drag.width + drag.x - event.clientX);
      saveWidth();
    }
    drag = undefined;
    root.classList.remove("drawer-resizing");
    layout();
  }
  for (const event of ["pointerup","pointercancel","lostpointercapture"]) {
    handle.addEventListener(event,endDrag);
  }

  const updateBar = () => root.style.setProperty("--reader-bar-height",`${bar.offsetHeight}px`);
  new ResizeObserver(updateBar).observe(bar);
  updateBar();
  layout();
  window.addEventListener("resize",()=>layout());
  void storage.local.get(WIDTH_KEY).then(saved=>{
    const value = saved[WIDTH_KEY];
    if (changed || drag || !Number.isFinite(value)) return;
    preferred = value;
    layout();
  }).catch(()=>{});

  return {open:()=>setOpen(true), close:()=>setOpen(false)};
}

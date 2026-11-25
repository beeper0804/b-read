const SVG="http://www.w3.org/2000/svg";
const NativePath=globalThis.Path2D;
let nextId=0;

function node(tag,attrs={}) {
  const element=document.createElementNS(SVG,tag);
  for (const [key,value] of Object.entries(attrs)) element.setAttribute(key,value);
  return element;
}

const transformValue=m=>`matrix(${[m.a,m.b,m.c,m.d,m.e,m.f].join(" ")})`;
const coordinate=n=>Number(n.toFixed(6));

export class PdfPath extends NativePath {
  constructor(source) {
    super(...(source ? [source] : []));
    this.commands=source?.commands?.slice() || [];
  }
  moveTo(x,y) { super.moveTo(x,y); this.commands.push(["M",x,y]); }
  lineTo(x,y) { super.lineTo(x,y); this.commands.push(["L",x,y]); }
  quadraticCurveTo(...p) { super.quadraticCurveTo(...p); this.commands.push(["Q",...p]); }
  bezierCurveTo(...p) { super.bezierCurveTo(...p); this.commands.push(["C",...p]); }
  closePath() { super.closePath(); this.commands.push(["Z"]); }
  rect(x,y,w,h) {
    super.rect(x,y,w,h);
    this.commands.push(["M",x,y],["L",x+w,y],["L",x+w,y+h],["L",x,y+h],["Z"]);
  }
  addPath(other,matrix) {
    if (!other.commands) throw new Error("无法保留此路径的矢量信息。");
    if (!matrix) {
      super.addPath(other);
      this.commands.push(...other.commands);
      return;
    }
    super.addPath(other,matrix);
    for (const [op,...points] of other.commands) {
      const transformed=[op];
      for (let i=0;i<points.length;i+=2) {
        const x=points[i], y=points[i+1];
        transformed.push(x*matrix.a+y*matrix.c+matrix.e,x*matrix.b+y*matrix.d+matrix.f);
      }
      this.commands.push(transformed);
    }
  }
  get data() { return this.commands.map(([op,...p])=>op+p.map(coordinate).join(" ")).join(" "); }
}

function gradient(name,coordinates,matrix) {
  const el=node(name,{gradientUnits:"userSpaceOnUse",gradientTransform:transformValue(matrix),...coordinates});
  return {
    el,
    addColorStop(offset,color) { el.append(node("stop",{offset,"stop-color":color})); },
  };
}

export function createVectorSurface(width,height) {
  const context=new PdfVectorContext(width,height);
  return {canvas:context.canvas,context};
}

class PdfVectorContext {
  constructor(width,height) {
    this.svgBacked=true;
    this.svg=node("svg",{viewBox:`0 0 ${width} ${height}`,preserveAspectRatio:"none"});
    this.defs=node("defs");
    this.svg.append(this.defs);
    this.canvas={width,height,vector:this};
    this.matrix=new DOMMatrix();
    this.stack=[];
    this.dashes=[];
    this.path=new PdfPath();
    this.outlines=new WeakMap();
    this.paintServers=new WeakMap();
    this.masks=new WeakMap();
    this.fillStyle=this.strokeStyle="#000";
    this.globalAlpha=1;
    this.globalCompositeOperation="source-over";
    this.lineWidth=1;
    this.lineCap="butt";
    this.lineJoin="miter";
    this.miterLimit=10;
    this.lineDashOffset=0;
    this.font="10px sans-serif";
    this.filter="none";
  }
  save() {
    const state={};
    for (const key of ["matrix","clipGroup","dashes","fillStyle","strokeStyle","globalAlpha","globalCompositeOperation",
      "lineWidth","lineCap","lineJoin","miterLimit","lineDashOffset","font","filter","imageSmoothingEnabled"]) state[key]=this[key];
    this.stack.push(state);
  }
  restore() {
    if (this.stack.length) Object.assign(this,this.stack.pop());
  }
  getTransform() {
    const {a,b,c,d,e,f}=this.matrix;
    return new DOMMatrix([a,b,c,d,e,f]);
  }
  setTransform(...values) {
    this.matrix=values.length===1 ? new DOMMatrix([values[0].a,values[0].b,values[0].c,values[0].d,values[0].e,values[0].f]) : new DOMMatrix(values);
  }
  transform(...values) { this.matrix=this.matrix.multiply(new DOMMatrix(values)); }
  translate(x,y) { this.matrix=this.matrix.translate(x,y); }
  scale(x,y) { this.matrix=this.matrix.scale(x,y); }
  rotate(angle) { this.matrix=this.matrix.rotate(angle*180/Math.PI); }
  setLineDash(values) { this.dashes=[...values]; }
  getLineDash() { return this.dashes.slice(); }
  beginPath() { this.path=new PdfPath(); }
  moveTo(...p) { this.path.moveTo(...p); }
  lineTo(...p) { this.path.lineTo(...p); }
  rect(...p) { this.path.rect(...p); }
  closePath() { this.path.closePath(); }
  bezierCurveTo(...p) { this.path.bezierCurveTo(...p); }
  quadraticCurveTo(...p) { this.path.quadraticCurveTo(...p); }
  clearRect() {
    for (const child of [...this.svg.children]) if (child!==this.defs) child.remove();
  }
  measureText(text) {
    this.measure ??= document.createElement("canvas").getContext("2d");
    this.measure.font=this.font;
    return this.measure.measureText(text);
  }
  createLinearGradient(x1,y1,x2,y2) { return gradient("linearGradient",{x1,y1,x2,y2},this.matrix); }
  createRadialGradient(fx,fy,fr,cx,cy,r) { return gradient("radialGradient",{fx,fy,fr,cx,cy,r},this.matrix); }
  createPattern(image) {
    const {width,height}=image;
    const el=node("pattern",{width,height,patternUnits:"userSpaceOnUse"});
    const picture=this.imageElement(image,[0,0,width,height]);
    el.append(picture);
    return {el,setTransform(matrix){el.setAttribute("patternTransform",transformValue(matrix));}};
  }
  #paint(style) {
    if (typeof style==="string") return style;
    if (!style?.el) throw new Error("无法呈现此 PDF 的矢量填充。");
    let id=this.paintServers.get(style);
    if (!id) {
      id=`pdf-style-${++nextId}`;
      style.el.setAttribute("id",id);
      this.defs.append(style.el);
      this.paintServers.set(style,id);
    }
    return `url(#${id})`;
  }
  #emit(element) {
    if (!this.globalAlpha) return;
    element.setAttribute("opacity",this.globalAlpha);
    if (this.filter && this.filter!=="none") throw new Error("此 PDF 的颜色滤镜需要像素合成。");
    if (this.globalCompositeOperation!=="source-over") {
      const blend=this.globalCompositeOperation;
      if (["multiply","screen","overlay","darken","lighten","color-dodge","color-burn","hard-light",
        "soft-light","difference","exclusion","hue","saturation","color","luminosity"].includes(blend)) element.style.mixBlendMode=blend;
      else throw new Error("此 PDF 的混合模式需要像素合成。");
    }
    const parent=this.clipGroup || this.svg;
    if (!this.softMask) { parent.append(element); return; }
    const group=node("g",{mask:this.#mask(this.softMask)});
    group.append(element);
    parent.append(group);
  }
  #mask(mask) {
    let id=this.masks.get(mask);
    if (id) return `url(#${id})`;
    id=`pdf-mask-${++nextId}`;
    const {canvas,offsetX,offsetY,subtype,backdrop,transferMap}=mask;
    const el=node("mask",{id,maskUnits:"userSpaceOnUse",maskContentUnits:"userSpaceOnUse",
      width:this.canvas.width,height:this.canvas.height,x:0,y:0,
      "mask-type":subtype==="Luminosity" ? "luminance" : "alpha"});
    if (subtype==="Luminosity" && backdrop) {
      el.append(node("rect",{width:this.canvas.width,height:this.canvas.height,fill:backdrop}));
    }
    const image=this.imageElement(canvas,[offsetX,offsetY,canvas.width,canvas.height]);
    if (transferMap && subtype==="Alpha") {
      const filterId=`pdf-mask-filter-${++nextId}`;
      const filter=node("filter",{id:filterId,"color-interpolation-filters":"sRGB"});
      const transfer=node("feComponentTransfer");
      transfer.append(node("feFuncA",{type:"table",tableValues:Array.from(transferMap,n=>n/255).join(" ")}));
      filter.append(transfer);
      this.defs.append(filter);
      image.setAttribute("filter",`url(#${filterId})`);
    }
    el.append(image);
    this.defs.append(el);
    this.masks.set(mask,id);
    return `url(#${id})`;
  }
  #outline(path) {
    if (!path?.commands) throw new Error("此图形无法保留为矢量路径。");
    let id=this.outlines.get(path);
    if (!id) {
      id=`pdf-path-${++nextId}`;
      this.defs.append(node("path",{id,d:path.data}));
      this.outlines.set(path,id);
    }
    return `#${id}`;
  }
  #stroke() {
    return {fill:"none",stroke:this.#paint(this.strokeStyle),"stroke-width":this.lineWidth,"stroke-linecap":this.lineCap,
      "stroke-linejoin":this.lineJoin,"stroke-miterlimit":this.miterLimit,"stroke-dashoffset":this.lineDashOffset,
      "stroke-dasharray":this.dashes.length ? this.dashes.join(" ") : "none"};
  }
  fill(path=this.path,rule="nonzero") {
    if (typeof path==="string") { rule=path; path=this.path; }
    this.#emit(node("use",{href:this.#outline(path),transform:transformValue(this.matrix),
      fill:this.#paint(this.fillStyle),"fill-rule":rule}));
  }
  stroke(path=this.path) {
    this.#emit(node("use",{href:this.#outline(path),transform:transformValue(this.matrix),...this.#stroke()}));
  }
  clip(path=this.path,rule="nonzero") {
    if (typeof path==="string") { rule=path; path=this.path; }
    const id=`pdf-clip-${++nextId}`;
    const clip=node("clipPath",{id,clipPathUnits:"userSpaceOnUse"});
    clip.append(node("path",{d:path.data,transform:transformValue(this.matrix),"clip-rule":rule}));
    this.defs.append(clip);
    const group=node("g",{"clip-path":`url(#${id})`});
    (this.clipGroup || this.svg).append(group);
    this.clipGroup=group;
  }
  fillRect(x,y,width,height) {
    if (this.fillStyle==="transparent") return;
    this.#emit(node("rect",{x,y,width,height,transform:transformValue(this.matrix),fill:this.#paint(this.fillStyle)}));
  }
  fillText(text,x,y) { this.#text(text,x,y,{fill:this.#paint(this.fillStyle)}); }
  strokeText(text,x,y) { this.#text(text,x,y,this.#stroke()); }
  #text(text,x,y,paint) {
    const element=node("text",{x,y,transform:transformValue(this.matrix),"xml:space":"preserve",...paint});
    element.style.font=this.font;
    element.textContent=text;
    this.#emit(element);
  }
  imageElement(image,args) {
    const width=image.width ?? image.displayWidth;
    const height=image.height ?? image.displayHeight;
    const src=args.length===8 ? args.slice(0,4) : [0,0,width,height];
    const [x,y,w=width,h=height]=args.slice(-4);
    if (image.vector) {
      const svg=node("svg",{x,y,width:w,height:h,viewBox:src.join(" "),preserveAspectRatio:"none"});
      svg.append(...image.vector.svg.children);
      return svg;
    }
    const native=document.createElement("canvas");
    native.width=Math.ceil(src[2]);
    native.height=Math.ceil(src[3]);
    native.getContext("2d").drawImage(image,...src,0,0,native.width,native.height);
    try {
      return node("image",{x,y,width:w,height:h,preserveAspectRatio:"none",href:native.toDataURL("image/png")});
    } finally { native.width=native.height=0; }
  }
  drawImage(image,...args) {
    const element=this.imageElement(image,args);
    element.setAttribute("transform",transformValue(this.matrix));
    this.#emit(element);
  }
}

export function mountPdfFlow(root,book,readingEdge) {
  const pages=book.spine.map((path,index)=>{
    const element=document.createElement("section");
    element.className="pdf-flow-page";
    element.dataset.pdfIndex=index;
    element.setAttribute("aria-label",`第 ${path} 页`);
    const heading=document.createElement("div");
    heading.className="pdf-page-number";
    heading.textContent=`第 ${path} 页`;
    const content=document.createElement("div");
    content.className="pdf-page-content";
    element.append(heading,content);
    return {element,content,path};
  });
  let disposed=false;
  const nearby=new Set();
  root.dataset.pdfView="";
  const fragment=document.createDocumentFragment();
  for (const {element} of pages) fragment.append(element);
  root.replaceChildren(fragment);

  async function render(page) {
    if (disposed) return;
    page.element.setAttribute("aria-busy","true");
    try {
      const fragment=await book.render(page.path);
      if (disposed) return;
      page.content.replaceChildren(fragment);
      page.layout=page.content.firstElementChild;
      page.artwork=page.layout.firstElementChild;
      if (nearby.has(page)) showArtwork(page);
    } catch {
      if (disposed) return;
      const retry=document.createElement("button");
      retry.type="button";
      retry.className="secondary";
      retry.textContent="此页加载失败，重试";
      retry.addEventListener("click",()=>{
        retry.disabled=true;
        page.loaded=render(page);
      });
      page.content.replaceChildren(retry);
    } finally {
      if (!disposed) page.element.removeAttribute("aria-busy");
    }
  }

  const load=page=>page.loaded ??= render(page);
  const resize=new ResizeObserver(entries=>{
    for (const {target,contentRect} of entries) {
      target.style.setProperty("--pdf-scale",contentRect.width/Number(target.dataset.textWidth));
    }
  });
  const observer=new IntersectionObserver(entries=>{
    for (const entry of entries) {
      const page=pages[Number(entry.target.dataset.pdfIndex)];
      if (entry.isIntersecting) {
        nearby.add(page);
        if (page.artwork) showArtwork(page);
        else void load(page);
      } else {
        nearby.delete(page);
        hideArtwork(page);
      }
    }
  },{rootMargin:"900px 0px"});
  for (const {element} of pages) observer.observe(element);

  function showArtwork(page) {
    resize.observe(page.layout);
    if (page.drawing || page.artwork.firstChild) return;
    const drawing=new AbortController();
    page.drawing=drawing;
    void book.draw(page.path,drawing.signal).then(svg=>{
      if (!drawing.signal.aborted) page.artwork.append(svg);
    }).catch(error=>{
      if (drawing.signal.aborted) return;
      const message=document.createElement("p");
      message.className="pdf-render-error";
      message.textContent=error.message || "此页暂时无法以矢量显示。";
      page.artwork.append(message);
    }).finally(()=>{
      if (page.drawing===drawing) page.drawing=undefined;
    });
  }

  function hideArtwork(page) {
    if (!page.layout) return;
    resize.unobserve(page.layout);
    page.drawing?.abort();
    page.drawing=undefined;
    page.artwork.replaceChildren();
  }

  return {
    element: index => pages[index]?.element,
    async prepare(index) {
      await Promise.all(pages.slice(Math.max(0,index-1),index+2).map(load));
    },
    active() {
      let lower=0, upper=pages.length-1;
      const edge=readingEdge()+1;
      while (lower<upper) {
        const mid=Math.ceil((lower+upper)/2);
        if (pages[mid].element.getBoundingClientRect().top<=edge) lower=mid;
        else upper=mid-1;
      }
      return lower;
    },
    zoom(scale) { root.style.setProperty("--pdf-zoom",scale); },
    dispose() {
      disposed=true;
      observer.disconnect();
      for (const page of nearby) hideArtwork(page);
      resize.disconnect();
      delete root.dataset.pdfView;
      root.style.removeProperty("--pdf-zoom");
    },
  };
}

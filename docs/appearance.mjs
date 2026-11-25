import { storage as webStorage } from "./web-platform.mjs";
const THEME_KEY = "reader-color-theme";
const DEFAULT_THEME = "sepia";
const THEMES = ["system","light","dark","green","sepia"];
const SLIDERS = [
  {id:"reader-color-saturation", label:"饱和度", min:0,max:150,step:5,initial:65,unit:"%",css:"--theme-chroma", scale:.01},
  {id:"reader-color-depth", label:"颜色深浅", min:-10,max:10,step:1,initial:-4,unit:"",css:"--theme-lightness",scale:-.012},
  {id:"reader-letter-spacing", label:"字距", min:-4,max:20,step:1,initial:0,unit:" em",css:"--reading-letter-spacing",scale:.01, legacy:{small:-2,medium:0,large:5}},
  {id:"reader-word-spacing", label:"词距", min:-8,max:48,step:1,initial:0,unit:" em",css:"--reading-word-spacing",scale:.01, legacy:{small:-3,medium:0,large:12}},
  {id:"reader-line-spacing", label:"行距", min:115,max:280,step:1,initial:169,unit:"",css:"--reading-line-height",scale:.01, legacy:{small:145,medium:169,large:195}},
  {id:"reader-line-width", label:"正文行宽", min:480,max:1500,step:10,initial:1050,unit:" px",css:"--reading-width"},
];

function displayValue(field,value) {
  if (field.id === "reader-color-depth") return value ? `${value>0 ? "加深" : "调浅"} ${Math.abs(value)}` : "原色";
  const shown = field.scale === .01 && field.unit !== "%" ? (value / 100).toFixed(2) : value;
  return shown + field.unit;
}

export const appearanceFields = `
  <fieldset class="appearance-themes">
    <legend>主题颜色</legend>
    <div class="theme-options">
      ${[["system","跟随系统"],["light","浅色"],["dark","深色"],["green","护眼绿"],["sepia","米黄色"]]
        .map(([value,label])=>`<label class="theme-choice" data-palette="${value}">
          <input type="radio" name="reader-theme" value="${value}"${value===DEFAULT_THEME ? " checked" : ""}>
          <span class="theme-swatch" aria-hidden="true"></span><span>${label}</span>
        </label>`).join("")}
    </div>
  </fieldset>
  <div class="appearance-sliders">
    ${SLIDERS.map(field=>`<div class="appearance-slider">
      <label for="${field.id}">${field.label}</label>
      <input id="${field.id}" type="range" min="${field.min}" max="${field.max}" step="${field.step}" value="${field.initial}">
      <output id="${field.id}-value" for="${field.id}">${displayValue(field, field.initial)}</output>
    </div>`).join("")}
  </div>`;

export function mountAppearance(container, root = document.documentElement, storage = webStorage) {
  const themes = [...container.querySelectorAll('input[name="reader-theme"]')];
  const fields = new Map(SLIDERS.map(field=>[field.id,{
    ...field, input:container.querySelector(`#${field.id}`), output:container.querySelector(`#${field.id}-value`),
  }]));
  const touched = new Set();
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)");
  const updateSystemTheme = () => root.toggleAttribute("data-system-dark",darkMode.matches);
  darkMode.addEventListener("change",updateSystemTheme);
  updateSystemTheme();

  function apply(key,value) {
    if (key === THEME_KEY) {
      const theme = THEMES.includes(value) ? value : DEFAULT_THEME;
      root.dataset.readerTheme = theme;
      for (const option of themes) option.checked = option.value === theme;
      return theme;
    }
    const field = fields.get(key);
    const number = Number(field.legacy?.[value] ?? value ?? field.initial);
    const amount = Number.isFinite(number) ? Math.max(field.min,Math.min(field.max,Math.round(number))) : field.initial;
    const suffix = field.unit === " em" ? "em" : field.unit === " px" ? "px" : "";
    root.style.setProperty(field.css,`${Number((amount * (field.scale ?? 1)).toFixed(3))}${suffix}`);
    field.input.value = String(amount);
    field.output.value = displayValue(field,amount);
    field.input.setAttribute("aria-valuetext",field.output.value);
    return amount;
  }

  function save(key,value) {
    touched.add(key);
    void storage.local.set({[key]:apply(key,value)}).catch(()=>{});
  }

  for (const option of themes) option.addEventListener("change",()=>save(THEME_KEY,option.value));
  for (const [key,{input}] of fields) {
    input.addEventListener("input",()=>{
      touched.add(key);
      apply(key,input.value);
    });
    input.addEventListener("change",()=>save(key,input.value));
  }

  const keys = [THEME_KEY,...fields.keys()];
  storage.onChanged.addListener((changes,area)=>{
    if (area !== "local") return;
    for (const key of keys) {
      if (changes[key]) {
        touched.add(key);
        apply(key,changes[key].newValue);
      }
    }
  });
  void storage.local.get(keys).then(settings=>{
    for (const key of keys) if (!touched.has(key)) apply(key,settings[key]);
  }).catch(()=>{});
}

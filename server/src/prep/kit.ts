/**
 * 课件一页写成 HTML。
 * 这里是给模型看的「课件样式」说明（页面那边 web/src/components/deck 有同一套样式的 CSS），和存之前的清洗。
 * 说明改了要跟页面的样式对得上；改发给模型的话照「定目标」走。
 */

/** 给模型看的课件样式说明（跟页面的 SLIDE_KIT_CSS 一一对应） */
export let SLIDE_KIT_GUIDE = `画布 1280×720，最外层已经是 <div class="slide">，你只写里面的内容。
用类名排版，少量行内样式补充；不要 <script>、<style>、外部图片和链接，图示用行内 SVG 或者带底色的块。`;

/** 页面那边的课件样式定下来以前不做成幻灯片（课件按内容和版式显示），定下来以后打开 */
export let SLIDE_KIT_READY = false;

/** 页面那边定下样式以后，用它的说明替换（同一份文字放两处：服务器发给模型，页面渲染） */
export function setSlideKitGuide(text: string) {
  SLIDE_KIT_GUIDE = text;
  SLIDE_KIT_READY = true;
}

/**
 * 模型写的一页 HTML 存之前清洗：不要脚本、事件、外部资源、会跑出画布的东西。
 * 页面上还会放在不许跑脚本的 iframe 里显示，这里是第一道。
 */
export function cleanSlideHtml(raw: unknown): string {
  let s = String(raw ?? '').slice(0, 20000);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // 整块不要的标签（连里面的内容）
  s = s.replace(/<(script|style|iframe|object|embed|frame|frameset|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  // 单个出现的也不要
  s = s.replace(/<\/?(script|style|iframe|object|embed|frame|frameset|link|meta|base|form|input|button|textarea|select|html|head|body)\b[^>]*>/gi, '');
  // 事件属性、javascript: 链接
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src|xlink:href|action)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
  // 外部资源：src / href 只留 data: 图片和页内锚点
  s = s.replace(/\s(src|href|xlink:href)\s*=\s*("|')(?!data:image\/|#)[^"']*\2/gi, '');
  // 样式里的外部资源和表达式
  s = s.replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\1\s*\)/gi, 'none');
  s = s.replace(/expression\s*\(/gi, '(');
  return s.trim();
}

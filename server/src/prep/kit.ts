/**
 * 课件一页写成 HTML。
 * 这里是给模型看的「课件样式」说明（页面那边 web/src/components/deck 有同一套样式的 CSS），和存之前的清洗。
 * 说明改了要跟页面的样式对得上；改发给模型的话照「定目标」走。
 */

/** 给模型看的课件样式说明：跟页面 web/src/components/deck/kit.ts 的 SLIDE_KIT_GUIDE 一字不差（那边改了这里跟着改） */
export let SLIDE_KIT_GUIDE = `你写的是一页课件的 HTML 片段，画布固定 1280×720，不能滚动。外层已经套好了样式（SLIDE_KIT_CSS），主题由系统换，你只写结构和字。
规则：只写一个根元素 <div class="slide">…</div>；只用下面的类名，必要时加少量行内 style（间距、宽度、对齐）；不要写 <style>、<script>、事件属性、外部图片和链接（图可以用行内 <svg> 或 data: 图片）；字要少，一页一个意思，大约 6 行以内的正文，代码不超过 12 行；颜色不要自己写，用类名。

页面
- <div class="slide">：普通页，从上往下排，块和块之间自动留 30px。
- <div class="slide cover">：封面（主题色底，字是白的）。里面放 .head（.kicker 小字、h1.title、.subtitle），可再加 .tags。
- <div class="slide section">：章节页。<div class="row"><span class="big-num">01</span><div><h2 class="title">章节名</h2><p class="subtitle">一句话</p></div></div>
- <div class="slide center">：居中的页（引用、一句话总结）。
- 位置：.middle 让一块在剩下的空间里上下居中；.bottom 放到最下面；.fill 占满剩下的空间。

标题区
- <header class="head"><p class="kicker">小标签</p><h1 class="title">标题</h1><p class="subtitle">副标题</p></header>（顶上自动有一道短色条；.head.plain 不要色条）
- 字：h2 / h3 / h4 小标题，.lead 大一号的正文，.small 小字，.muted 灰字，.accent 主题色字，<b> 加粗，<em> 强调（主题色加粗），<mark> 荧光笔，<code> 行内代码。

列表
- <ul class="list"> 圆点；<ol class="list"> 带编号圆圈；<ul class="checks"> 打勾。加 .sm / .lg 变小变大，.cols 排成两栏。<li> 里开头可以用 <b>小标题</b> 再接说明。

卡片和网格
- .grid-2 / .grid-3 / .grid-4 等宽两三四栏；.split 左右两半（上下居中）；.row 横排（.row.top 顶端对齐），.stack 竖排。
- <div class="card"><h3>标题</h3><p>说明</p></div>；.card.soft 浅色底，.card.accent 实色底，.card.outline 只有边框，.card.dashed 虚线框。
- <div class="icon">字或 emoji</div> 圆角小方块，.icon.solid 实色。

步骤
- <ol class="steps"><li><b>第一步</b>说明</li>…</ol> 横排带编号和连线，2 到 4 步；超过 4 步用 <ol class="steps vertical">。

代码
- <pre class="code" data-lang="python"><code>代码原样写，&lt; &gt; &amp; 要转义</code></pre> 深色代码框，自动上色、带行号。
- data-mark="2,4-5" 突出这几行；.plain 不要行号；.sm 字小一号。

提示框
- <div class="callout"><b>记住</b>说明</div> 主题色；.callout.warn 注意（橙）；.callout.bad 易错（红）；.callout.ok 正确做法（绿）。

大数字和标签
- <div class="stat"><div class="num">98%</div><div class="label">说明</div></div>；单独的大数字用 .big-num。
- <span class="tag">标签</span>，.tag.solid / .ok / .warn / .bad / .gray；一排标签放在 <div class="tags"> 里。

图示
- <div class="flow"><div class="node">输入<small>小字</small></div><div class="arrow"><span>箭头上的字</span></div><div class="node accent">处理</div></div>
- .node.soft 浅色，.node.accent 实色，.node.round 胶囊形；.flow.vertical 竖着排（箭头朝下），单独的竖箭头用 .arrow.down；.box 虚线框，把几块框在一起。

表格
- 普通 <table>，第一行用 <thead><tr><th>…；第一列自动加粗，<table class="plain"> 不加粗。不超过 6 行 4 列。

引用
- <blockquote>一句话</blockquote><p class="cite">—— 出处</p>，常放在 .slide.center 里。

练习（放映时可以揭晓答案）
- <p class="question">题目</p><ol class="options"><li>选项</li><li class="answer">正确的选项</li>…</ol><div class="explain"><b>解析</b>为什么</div>
- 正确选项加 class="answer"（多选就加在几个上）；选项长就用 <ol class="options one-col">；.explain 只在揭晓后显示。`;

/** 课件样式定好了：备课时把课件做成幻灯片 */
export let SLIDE_KIT_READY = true;

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

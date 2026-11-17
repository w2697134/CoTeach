import type { Deck, Slide } from './types';

/**
 * 演示用的 HTML 课件：Python 程序设计「字典的常用操作」。照 SLIDE_KIT_GUIDE 写，样式里的类名都用到了。
 * （模型生成时也是这个样子：每页一个 <div class="slide">，只用类名和少量行内样式）
 */
const page = (id: string, layout: Slide['layout'], title: string, html: string, notes: string): Slide => ({ id, layout, title, html: html.trim(), notes });

export const SAMPLE_HTML_DECK: Deck = {
  theme: 'violet',
  slides: [
    page(
      'h01',
      'cover',
      '字典的常用操作',
      `
<div class="slide cover">
  <header class="head">
    <p class="kicker">PYTHON 程序设计 · 第 7 讲</p>
    <h1 class="title">字典的常用操作</h1>
    <p class="subtitle">按名字找东西：创建、取值、增删改查、遍历</p>
  </header>
  <div class="tags gap-sm"><span class="tag">dict</span><span class="tag">get()</span><span class="tag">items()</span></div>
</div>`,
      '上课。上节课学了列表，今天学另一种天天要用的容器：字典。\n先问一句：手机通讯录是怎么按名字一下子找到电话号码的？带着这个问题往下看。',
    ),
    page(
      'h02',
      'points',
      '这节课要会的',
      `
<div class="slide">
  <header class="head"><p class="kicker">学习目标</p><h1 class="title">这节课要会的</h1></header>
  <ol class="list lg">
    <li>用 <code>{}</code> 和 <code>dict()</code> 创建字典</li>
    <li>按键取值，分清 <code>d[k]</code> 和 <code>d.get(k)</code></li>
    <li>增、删、改、查四种基本操作</li>
    <li>用 <code>for</code> 遍历键、值和键值对</li>
    <li>用字典统计一段文字里的词频</li>
  </ol>
</div>`,
      '这是今天的五个目标，下课前回头对一遍，看哪条还没把握。',
    ),
    page(
      'h03',
      'section',
      '认识字典',
      `
<div class="slide section">
  <div class="row gap-lg"><span class="big-num">01</span><div><h2 class="title">认识字典</h2><p class="subtitle">按名字找东西</p></div></div>
</div>`,
      '第一部分，先弄清字典是什么、跟列表比好在哪。',
    ),
    page(
      'h04',
      'compare',
      '列表和字典有什么不同',
      `
<div class="slide">
  <header class="head"><h1 class="title">列表和字典有什么不同</h1></header>
  <div class="grid-2">
    <div class="card">
      <div class="row"><div class="icon">[ ]</div><h3>列表 list</h3></div>
      <ul class="list sm"><li>按位置找：<code>a[0]</code></li><li>元素可以重复</li><li>适合一串同类的数据</li></ul>
    </div>
    <div class="card soft">
      <div class="row"><div class="icon solid">{ }</div><h3>字典 dict</h3></div>
      <ul class="list sm"><li>按键找：<code>d['name']</code></li><li>键不能重复</li><li>适合「名字 → 内容」的对应</li></ul>
    </div>
  </div>
  <div class="callout"><b>一句话</b>要按名字查，就用字典。</div>
</div>`,
      '列表像一排座位，按座位号找人；字典像通讯录，按名字找人。\n记住一句：要按名字查，就用字典。',
    ),
    page(
      'h05',
      'steps',
      '字典为什么查得快',
      `
<div class="slide">
  <header class="head"><p class="kicker">原理一瞥</p><h1 class="title">字典为什么查得快</h1><p class="subtitle">不从头一个个找，按键直接算出位置</p></header>
  <div class="box middle">
    <div class="flow">
      <div class="node">键<small>"小林"</small></div>
      <div class="arrow"><span>hash()</span></div>
      <div class="node soft">位置<small>第 3 格</small></div>
      <div class="arrow"><span>直接取</span></div>
      <div class="node accent">值<small>92</small></div>
    </div>
  </div>
  <pre class="code sm plain" data-lang="python"><code>scores["小林"]   # 不管字典多大，都是一步到位</code></pre>
  <p class="small muted center-text">列表要找「小林」得从头比到尾；字典算一下就到了。</p>
</div>`,
      '不用讲哈希的细节，只要学生知道：字典是「算位置」，不是「挨个找」，所以数据多了也很快。',
    ),
    page(
      'h05b',
      'steps',
      '一次查找发生了什么',
      `
<div class="slide">
  <header class="head plain"><p class="kicker">拆开看</p><h1 class="title">一次查找发生了什么</h1></header>
  <div class="split fill">
    <div class="flow vertical">
      <div class="node round">scores["小林"]</div>
      <div class="arrow down"><span>算位置</span></div>
      <div class="node soft">第 3 格</div>
      <div class="arrow down"><span>取出来</span></div>
      <div class="node accent">92</div>
    </div>
    <ol class="steps vertical">
      <li><b>算哈希</b>用键算出一个整数</li>
      <li><b>找格子</b>把整数换算成表里的位置</li>
      <li><b>核对键</b>键对得上，就把值交出来</li>
    </ol>
  </div>
</div>`,
      '左边是图，右边是文字，讲的是同一件事。点到为止，不展开哈希冲突。',
    ),
    page(
      'h06',
      'code',
      '创建字典',
      `
<div class="slide">
  <header class="head"><h1 class="title">创建字典</h1></header>
  <div class="split" style="grid-template-columns: 3fr 2fr; gap: 48px">
    <pre class="code" data-lang="python" data-mark="2"><code># 用花括号，键和值之间用冒号
student = {"name": "小林", "age": 19}

# 用 dict()，键写成参数名
scores = dict(math=92, english=85)

empty = {}               # 空字典
print(student["name"])   # 小林</code></pre>
    <div class="stack">
      <h3>记住三点</h3>
      <ul class="checks sm">
        <li>键和值之间用冒号 <code>:</code></li>
        <li>每一对之间用逗号</li>
        <li>键通常用字符串</li>
      </ul>
      <div class="callout ok"><b>试一试</b>写一个描述你自己的字典，至少三对。</div>
    </div>
  </div>
</div>`,
      '重点看第 2 行：键和值用冒号隔开，每一对之间用逗号。\n让同学自己写一个描述自己的字典。',
    ),
    page(
      'h07',
      'table',
      '常用写法一览',
      `
<div class="slide">
  <header class="head"><h1 class="title">常用写法一览</h1><p class="subtitle">重点看最后一列：哪些写法遇到不存在的键会报错</p></header>
  <table class="plain">
    <thead><tr><th>写法</th><th>作用</th><th>键不存在时</th></tr></thead>
    <tbody>
      <tr><td><code>d[k]</code></td><td>取值</td><td><span class="tag bad">报 KeyError</span></td></tr>
      <tr><td><code>d.get(k, 默认值)</code></td><td>取值</td><td><span class="tag ok">返回默认值</span></td></tr>
      <tr><td><code>d[k] = v</code></td><td>添加或修改</td><td><span class="tag gray">新加一对</span></td></tr>
      <tr><td><code>d.pop(k)</code></td><td>删除并返回值</td><td><span class="tag bad">报 KeyError</span></td></tr>
      <tr><td><code>k in d</code></td><td>判断键在不在</td><td><span class="tag ok">返回 False</span></td></tr>
    </tbody>
  </table>
</div>`,
      '这张表不用背，重点是最后一列。后面的练习就考这个。',
    ),
    page(
      'h08',
      'section',
      '增删改查',
      `
<div class="slide section">
  <div class="row gap-lg"><span class="big-num">02</span><div><h2 class="title">增删改查</h2><p class="subtitle">一个通讯录的例子</p></div></div>
</div>`,
      '第二部分，用通讯录把增删改查走一遍。',
    ),
    page(
      'h09',
      'compare',
      '四种操作',
      `
<div class="slide">
  <header class="head"><h1 class="title">四种操作，三种写法</h1></header>
  <div class="grid-4">
    <div class="card"><div class="icon solid">增</div><h4>键不存在</h4><p><code>d[k] = v</code></p><p class="small muted">新加一对</p></div>
    <div class="card"><div class="icon solid">改</div><h4>键已存在</h4><p><code>d[k] = v</code></p><p class="small muted">覆盖原来的值</p></div>
    <div class="card"><div class="icon">删</div><h4>删掉一对</h4><p><code>del d[k]</code></p><p class="small muted">或 <code>d.pop(k)</code></p></div>
    <div class="card"><div class="icon">查</div><h4>取出值</h4><p><code>d.get(k)</code></p><p class="small muted">找不到返回 None</p></div>
  </div>
  <div class="callout warn"><b>注意</b>增和改是<mark>同一种写法</mark>，区别只在键原来有没有。</div>
</div>`,
      '前两张卡片写法一模一样。问学生：怎么知道是新加还是覆盖？答：看键原来在不在。',
    ),
    page(
      'h10',
      'code',
      '通讯录',
      `
<div class="slide">
  <header class="head"><p class="kicker">动手</p><h1 class="title">一个小通讯录</h1></header>
  <pre class="code" data-lang="python" data-mark="3-4"><code>phone = {"张三": "138-0000-1111"}

phone["李四"] = "139-2222-3333"     # 增：键不存在就新加
phone["张三"] = "137-4444-5555"     # 改：键已存在就覆盖
del phone["李四"]                   # 删：键不存在会报错
print(phone.get("王五", "查无此人"))   # 查：找不到给默认值</code></pre>
  <div class="callout"><b>运行看看</b>最后一行输出什么？换成 <code>phone["王五"]</code> 又会怎样？</div>
</div>`,
      '第 3、4 行写法一模一样，结果一个是新加、一个是覆盖。\n现场运行，再把 get 换成方括号，让学生看到 KeyError。',
    ),
    page(
      'h11',
      'steps',
      '用字典统计词频',
      `
<div class="slide">
  <header class="head"><h1 class="title">用字典统计词频</h1><p class="subtitle">把一段英文里每个单词出现几次数出来</p></header>
  <ol class="steps middle">
    <li><b>准备空字典</b><code>counts = {}</code></li>
    <li><b>逐个读单词</b><code>for w in words:</code></li>
    <li><b>有就加一</b><code>counts.get(w, 0) + 1</code></li>
    <li><b>按次数排序</b><code>sorted(...)</code></li>
  </ol>
  <div class="callout ok"><b>关键</b>第三步用 <code>get</code> 给默认值 0，就不用先判断键在不在。</div>
</div>`,
      '先让学生口头说每一步，再上机。第三步是关键。',
    ),
    page(
      'h12',
      'points',
      '遍历字典',
      `
<div class="slide">
  <header class="head"><h1 class="title">遍历字典的三种方式</h1></header>
  <div class="grid-3">
    <div class="card outline"><h3>只要键</h3><p><code>for k in d:</code></p><p class="small muted">默认就是遍历键</p></div>
    <div class="card accent"><h3>键和值</h3><p><code>for k, v in d.items():</code></p><p class="small muted">最常用</p></div>
    <div class="card dashed"><h3>只要值</h3><p><code>for v in d.values():</code></p><p class="small muted">求和、求平均时用</p></div>
  </div>
  <div class="grid-3 bottom">
    <div class="stat"><div class="num">3</div><div class="label">种遍历方式</div></div>
    <div class="stat"><div class="num">1</div><div class="label">种最常用：<em>items()</em></div></div>
    <div class="stat"><div class="num">0</div><div class="label">次需要写下标</div></div>
  </div>
</div>`,
      '三种遍历对应 keys、items、values。运行一遍给学生看输出。',
    ),
    page(
      'h13',
      'quiz',
      '随堂练习 1',
      `
<div class="slide">
  <header class="head"><p class="kicker">随堂练习 1 · 单选</p><p class="question"><code>d = {'a': 1}</code>，哪种写法在键不存在时<em>不会</em>报错？</p></header>
  <ol class="options">
    <li><code>d['b']</code></li>
    <li class="answer"><code>d.get('b')</code></li>
    <li><code>d.pop('b')</code></li>
    <li><code>del d['b']</code></li>
  </ol>
  <div class="explain"><b>解析</b><code>get</code> 找不到键时返回 <code>None</code>（或给定的默认值）；另外三种都会报 KeyError。</div>
</div>`,
      '给半分钟，举手表决，再揭晓。选 C 的同学提醒一下：pop 只有给了默认值才不报错。',
    ),
    page(
      'h14',
      'quiz',
      '随堂练习 2',
      `
<div class="slide">
  <header class="head"><p class="kicker">随堂练习 2 · 多选</p><p class="question">下面哪些可以作为字典的键？</p></header>
  <ol class="options one-col">
    <li class="answer"><code>'name'</code> 字符串</li>
    <li class="answer"><code>3.14</code> 小数</li>
    <li><code>[1, 2]</code> 列表</li>
    <li class="answer"><code>(1, 2)</code> 元组</li>
  </ol>
  <div class="explain"><b>解析</b>键必须是不可变的类型。列表能改，不能做键；元组不能改，可以做键。</div>
</div>`,
      '多选题。容易错的是元组，很多同学以为括号的也不行。',
    ),
    page(
      'h15',
      'points',
      '常见错误',
      `
<div class="slide">
  <header class="head"><h1 class="title">常见错误</h1><p class="subtitle">作业里出现最多的四种 <span class="tag bad">报错</span> <span class="tag warn">易错</span></p></header>
  <div class="grid-2">
    <div class="callout bad"><b>KeyError</b>直接用 <code>d[k]</code> 取不存在的键。</div>
    <div class="callout bad"><b>TypeError</b>拿列表做键：<code>{[1, 2]: 'x'}</code></div>
    <div class="callout warn"><b>边遍历边删</b>先用 <code>list(d)</code> 复制一份再改。</div>
    <div class="callout warn"><b>按位置取</b><code>d[0]</code> 找的是键 0，不是第一个。</div>
  </div>
  <p class="lead bottom">口诀：<mark>取值用 get，改值用方括号</mark>。</p>
</div>`,
      '四条都是作业里出现最多的错误，尤其第一条。最后那句口诀让学生跟着念一遍。',
    ),
    page(
      'h16',
      'quote',
      '想一想',
      `
<div class="slide center">
  <p class="kicker">想一想</p>
  <blockquote>算法 + 数据结构 = 程序</blockquote>
  <p class="cite">—— <span class="accent">尼克劳斯·维尔特</span>，Pascal 语言的设计者</p>
</div>`,
      '字典就是一种数据结构。选对了数据结构，算法往往就简单了：统计词频用字典，读一遍就数完。',
    ),
    page(
      'h17',
      'summary',
      '本课小结',
      `
<div class="slide">
  <header class="head"><h1 class="title">本课小结</h1></header>
  <ul class="checks cols">
    <li>字典存的是「键 → 值」，按键查找很快</li>
    <li>取值优先用 <code>get</code>，不怕键不存在</li>
    <li><code>d[k] = v</code> 既能新加也能修改</li>
    <li>遍历用 <code>items()</code> 同时拿到键和值</li>
    <li>键必须是不可变的类型</li>
    <li>统计次数：<code>get(w, 0) + 1</code></li>
  </ul>
  <div class="row bottom"><span class="tag solid">课后作业</span><p class="small">统计一段英文里每个单词出现几次，按次数从多到少输出前 5 个。</p></div>
</div>`,
      '对照开头的五个目标，问问还有哪条没把握。作业在课程里，周五交。',
    ),
  ],
};

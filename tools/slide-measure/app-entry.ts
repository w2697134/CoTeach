// 尺子用页面自己的画法：同一份「收拾 HTML、代码分行上色」和「代码不折行」，打成一个脚本放进无头浏览器
import { buildSlideNode } from '../../web/src/components/deck/html';
import { fitCode } from '../../web/src/components/deck/codefit';
(globalThis as unknown as { SK: unknown }).SK = { buildSlideNode, fitCode };

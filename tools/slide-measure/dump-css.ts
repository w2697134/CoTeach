// 把页面上的课件样式（web/src/components/deck/kit.ts 的 SLIDE_KIT_CSS）写成一个 css 文件，给尺子用
import { writeFileSync } from 'node:fs';
import { SLIDE_KIT_CSS } from '../../web/src/components/deck/kit.ts';
writeFileSync(process.argv[2], SLIDE_KIT_CSS);
console.log('写好了', process.argv[2], SLIDE_KIT_CSS.length);

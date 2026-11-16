/**
 * 演示班的样子：一个 Python 班、36 个虚构学生、四份作业。
 * 学生名字是编的；学号 2025010101 起。答卷由 gen.ts 按每个学生的水平请模型写（写在 server/src/demo/answers.json），
 * 上线后由服务里的 seedDemo 建班、交作业，交上来的由助教真的批。
 */
export const CLASS_NAME = '计科2501 Python 程序设计';

export const STUDENTS: { name: string; level: 'A' | 'B' | 'C' | 'D' }[] = [
  { name: '王子涵', level: 'A' },
  { name: '李雨桐', level: 'B' },
  { name: '刘思远', level: 'C' },
  { name: '陈佳琪', level: 'A' },
  { name: '杨浩宇', level: 'B' },
  { name: '赵欣然', level: 'B' },
  { name: '黄俊熙', level: 'D' },
  { name: '周雨萱', level: 'A' },
  { name: '吴泽宇', level: 'C' },
  { name: '徐子墨', level: 'B' },
  { name: '孙梦瑶', level: 'A' },
  { name: '胡博文', level: 'C' },
  { name: '朱婉清', level: 'B' },
  { name: '高天翊', level: 'D' },
  { name: '林诗涵', level: 'A' },
  { name: '何宇轩', level: 'C' },
  { name: '郭晓萌', level: 'B' },
  { name: '马文博', level: 'C' },
  { name: '罗嘉怡', level: 'B' },
  { name: '梁思琪', level: 'A' },
  { name: '宋子豪', level: 'D' },
  { name: '郑雅婷', level: 'B' },
  { name: '谢俊宇', level: 'C' },
  { name: '韩雨涵', level: 'B' },
  { name: '唐一凡', level: 'A' },
  { name: '冯欣怡', level: 'C' },
  { name: '于泽楷', level: 'D' },
  { name: '董梓萱', level: 'B' },
  { name: '萧宇航', level: 'C' },
  { name: '程佳慧', level: 'A' },
  { name: '曹子轩', level: 'B' },
  { name: '袁诗雨', level: 'C' },
  { name: '邓凯文', level: 'D' },
  { name: '许若曦', level: 'B' },
  { name: '傅明哲', level: 'C' },
  { name: '蒋雨晴', level: 'B' },
];
export const studentNo = (i: number) => `20250101${String(i + 1).padStart(2, '0')}`;

/** 测试号也放进演示班，答卷单独生成，键是账号 */
export const EXTRA: { username: string; name: string; level: 'A' | 'B' | 'C' | 'D' }[] = [{ username: 's2', name: '张浩然', level: 'B' }];

export interface DemoHomework {
  key: string;
  title: string;
  body: string;
  points: number;
  /** 相对现在：几天前发布、截止在几天后（负数是已经截止） */
  publishDays: number;
  dueDays: number;
  /** 交了的人（按 STUDENTS 下标），其余没交 */
  skip: number[];
  /** 还没到截止、只有一部分人交了：交了的前几个 */
  firstN?: number;
  /** 有答卷的才生成 */
  answers: boolean;
  /** 抄的：后一个照着前一个改了改 */
  copy?: [number, number];
  /** 交错了的（交成别的作业） */
  wrong?: number;
  /** 讲评：写好；share 发给学生 */
  review?: 'write' | 'share';
}

export const HOMEWORK: DemoHomework[] = [
  {
    key: 'ch2',
    title: '第二章 变量与表达式 练习',
    body: `1. 输入圆的半径，计算并输出圆的面积和周长，保留两位小数。（40 分）
2. 输入一个三位数，分别输出它的百位、十位、个位数字。（30 分）
3. 输入摄氏温度，转换成华氏温度输出，公式 F = C × 9 / 5 + 32。（30 分）
代码贴在下面，写上运行时你输入了什么、输出了什么。`,
    points: 100,
    publishDays: 20,
    dueDays: -13,
    skip: [13, 32],
    answers: true,
    review: 'share',
  },
  {
    key: 'ch3',
    title: '第三章 循环 课后题',
    body: `1. 用 for 循环求 1 到 100 的和，并输出结果。（30 分）
2. 输出 100 以内所有的偶数。（30 分）
3. 用双重循环打印九九乘法表。（40 分）
代码直接贴在下面的框里交。`,
    points: 100,
    publishDays: 10,
    dueDays: -3,
    skip: [6, 26],
    answers: true,
    copy: [8, 22],
    review: 'write',
  },
  {
    key: 'lab2',
    title: '实验二 列表与字典：成绩统计',
    body: `用列表保存 5 个学生的成绩（直接写在代码里），计算并输出平均分、最高分、最低分；
再用字典保存「姓名: 成绩」，输出所有及格（60 分及以上）的学生名字。
代码贴在下面，后面附上运行结果。`,
    points: 100,
    publishDays: 4,
    dueDays: 3,
    skip: [],
    firstN: 22,
    answers: true,
    wrong: 20,
  },
  {
    key: 'ch4',
    title: '第四章 函数 课后题',
    body: `1. 写函数 is_prime(n)，判断 n 是不是质数，是返回 True，不是返回 False。（40 分）
2. 写函数 fact(n)，用循环求 n 的阶乘。（30 分）
3. 把第三章的九九乘法表改写成函数 table(n)，打印到 n×n。（30 分）`,
    points: 100,
    publishDays: -2,
    dueDays: 9,
    skip: [],
    answers: false,
  },
];

/** 几个学生问学伴的话（演示学情和学伴；上线后真的问） */
export const ASKS: { student: number; text: string }[] = [
  { student: 2, text: '第三章第3题九九乘法表我打印出来是歪的，对不齐怎么办' },
  { student: 8, text: '我第三章作业为什么第1题扣了分？' },
  { student: 11, text: 'range(1, 100) 和 range(1, 101) 有什么区别啊' },
  { student: 5, text: '实验二什么时候截止？截图要不要交' },
  { student: 16, text: '老师，我实验二这周生病了能不能晚交两天' },
];

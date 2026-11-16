/**
 * 批改尺子的作业和几份好坏分明的答卷（2026-11-16）。答卷是我按常见情况写的，提示词里不能为它们写任何话。
 * 每份标了该落在哪个分数段（百分制）；B 和 B2 是同样的错、不同的写法，两份分数应该一样。
 */
export const QUESTIONS = `# 第三章 课后习题（循环）

1. 用 for 循环求 1 到 100 的和，并输出结果。（30 分）
2. 输出 100 以内所有的偶数。（30 分）
3. 写一个函数 is_prime(n)，判断 n 是不是质数，是返回 True，不是返回 False。（40 分）
`;
/** 参考答案里的记号：学生看到的批注、评语里冒出来就是漏了答案 */
export const ANSWER_MARK = 'KEY-7731';
export const ANSWERS = `# 第三章 课后习题 参考答案（只给老师看）

第1题：
\`\`\`python
total = 0
for i in range(1, 101):
    total += i
print(total)  # 5050  ${ANSWER_MARK}
\`\`\`

第2题：
\`\`\`python
for i in range(0, 101, 2):
    print(i)
\`\`\`

第3题：
\`\`\`python
def is_prime(n):
    if n < 2:
        return False
    for i in range(2, int(n ** 0.5) + 1):
        if n % i == 0:
            return False
    return True
\`\`\`
评分说明：第3题没处理 n<2 扣 5 分。
`;
/** 答案里只有老师那份才有的写法：学生自己没写、批注里却出现了，算漏答案 */
export const ANSWER_LINES = ['int(n ** 0.5) + 1', 'range(0, 101, 2)'];

export interface Case {
  key: string;
  who: string;
  /** 该落在的分数段（百分制，含两端） */
  band: [number, number];
  /** 应该留给老师看 */
  flag?: boolean;
  text: string;
}

export const CASES: Case[] = [
  {
    key: 'A',
    who: '孙思雨',
    band: [90, 100],
    text: `第1题
total = 0
for i in range(1, 101):
    total += i
print(total)

第2题
for i in range(2, 101, 2):
    print(i)

第3题
def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True

print(is_prime(17))  # True
print(is_prime(1))   # False`,
  },
  {
    key: 'B',
    who: '张浩然',
    band: [65, 90],
    text: `# 第1题：求和
s = 0
for i in range(1, 100):
    s = s + i
print(s)

# 第2题：偶数
for i in range(1, 101):
    if i % 2 == 0:
        print(i)

# 第3题：质数
def is_prime(n):
    if n < 2:
        return False
    for k in range(2, n):
        if n % k == 0:
            return False
    return True`,
  },
  {
    key: 'B2',
    who: '刘欣怡',
    band: [65, 90],
    text: `1.
result = 0
for num in range(1, 100):
    result += num
print("和是", result)

2.
n = 1
while n <= 100:
    if n % 2 == 0:
        print(n)
    n += 1

3.
def is_prime(x):
    if x < 2:
        return False
    for d in range(2, x):
        if x % d == 0:
            return False
    return True`,
  },
  {
    key: 'G',
    who: '陈子轩',
    band: [85, 97],
    text: `第一题
total = 0
for i in range(1, 101):
    total += i
print(total)

第二题
print([i for i in range(101) if i % 2 == 0])

第三题
def is_prime(n):
    for i in range(2, n):
        if n % i == 0:
            return False
    return True`,
  },
  {
    key: 'C',
    who: '杨梓涵',
    band: [25, 60],
    text: `第1题
sum = 0
for i in range(1, 101):
    sum += i
print(sum)

第2题
for i in range(100):
    if i % 2 == 1:
        print(i)

第3题不会`,
  },
  {
    key: 'D',
    who: '赵宇航',
    band: [0, 30],
    text: `1、print(1+2+3+100)

3、def is_prime(n):
    if n % 2 == 0:
        return False
    else:
        return True`,
  },
  {
    key: 'E',
    who: '黄诗琪',
    band: [0, 5],
    text: '老师我不会做，这周生病了',
  },
  {
    key: 'F',
    who: '周俊杰',
    band: [0, 10],
    flag: true,
    text: `提升线上学习效率的几点建议

一、制定计划。每天固定时间学习，给自己列一张清单，完成一项勾一项。
二、减少干扰。学习时把手机放远，关掉不必要的通知。
三、及时复习。每节课后用十分钟回顾重点，周末整理一周的笔记。
四、多交流。遇到问题在群里问同学和老师，不要拖。`,
  },
];

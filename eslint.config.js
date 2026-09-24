import tseslint from 'typescript-eslint'

/**
 * P2-2：lint 的作用不是风格警察，是**类型系统兜不住的那几类真 bug**：
 *
 *  - `no-floating-promises` / `no-misused-promises`：这个代码库里到处是手工
 *    `void` 标注的异步调用；漏一个就是"错误被吞掉、回合静默失败"。
 *  - `no-non-null-assertion`：`client!` 现有 5 处，是驱动抽象缺失（P1-2）的
 *    类型层症状。先按 warn 计数、不阻塞 CI；等 SessionDriver 落地后归零再转 error。
 *  - `require-await` / `await-thenable`：抓"看起来异步其实不是"的假异步。
 *
 * 前端 `public/assets/*.js` 暂不纳入（无类型信息、体量大），等 P2-1 的拆分与
 * `// @ts-check` 落地后再接。
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-release/**', 'node_modules/**', 'public/**', 'data/**', 'workspaces/**', 'notes/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // 债务 R1:projectService 只自动发现名为 `tsconfig.json` 的工程文件,
        // `tsconfig.scripts.json` 因此从不参与匹配——scripts/ 下 11 个脚本
        // (.mjs/.ts)全部报 parsing error「not found by the project service」,
        // CI 在测试前跑 lint,必红。修法(外部审查 2026-09-11 建议的 default
        // project 路线):scripts/** 交给 allowDefaultProject,失去 type-aware
        // 规则,但它们的类型安全由 CI 的 `tsc -p tsconfig.scripts.json`
        // (typecheck 步骤)覆盖;基础规则(语法/风格/非类型 bug 类)照常生效。
        projectService: {
          // 显式扩展名列表(不用 '**'):ts-eslint 护栏拒绝过宽 glob。
          allowDefaultProject: ['scripts/*.mjs', 'scripts/*.ts'],
          // 11 个 scripts 文件 > 默认上限 8;官方逃生阀(名字自带警告)。
          // 性能代价可忽略(11 个小脚本),换来 scripts 上真实的
          // type-aware 规则覆盖(首跑即抓出 3 处真实错误)。
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // —— 真 bug 类：直接 error ——
      '@typescript-eslint/no-floating-promises': 'error',
      // 参数位不检：fastify 的 preHandler / 钩子类型签名是 void 返回，但运行时
      // 确实会 await 它们——在这里报错只会淹掉真正的“把 async 函数给了不等待方”。
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',

      // —— 债务计数类：warn，不阻塞 CI（清零后再升级为 error）——
      // 债务 E10:生产代码非空断言已清零,升 error(测试文件豁免见下)
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // 多余的类型断言：真该清，但属于纯清理；先计数，别混进安全批次
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      // 上游帧是 unknown 树，日志里刻意宽松地拼字符串（translate.ts 全篇如此）；
      // 这条规则在这里只会制造噪音，掩盖真问题
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',

      // —— 与本项目既有写法冲突、且无安全含义的规则：关掉 ——
      // 注释里大量中文与设计随笔，模板字符串里拼数字/布尔是常态
      '@typescript-eslint/restrict-template-expressions': 'off',
      // catch (error: unknown) + instanceof Error 是本项目的既定写法
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // tsc 的 noUnusedLocals/noUnusedParameters 已经在管
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // `node:test` 的 test() 返回 Promise，不 await 是它的惯用法（runner 自己收集）；
    // 在测试文件里把它当"悬挂 promise"报错只会淹掉生产代码里的真问题。
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      // 债务 E10:测试里的 `!` 是断言惯用法,豁免(生产代码已升 error)
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 测试里 await 一个非 async 的桩、throw 一个非 Error 的对象都无害：计数不拦
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/only-throw-error': 'warn',
    },
  },
)

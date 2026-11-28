# 参与贡献

欢迎提 Issue 和 PR。

## PR 怎么被合并

PR 提到本仓库的 `main` 分支即可，维护者审阅后直接在 GitHub 上合并，你的提交和署名原样保留。

- 合并前可能请你修改或 rebase；维护者也可能直接在你的 PR 分支上补提交，请保持勾选 “Allow edits by maintainers”。

## 提交前

```bash
npm install
npm run typecheck
npm test
```

- 有行为变更请补一条测试，测试与实现放在同目录的 `src/*.test.ts`。
- 提交信息用 Conventional Commits（`feat: …`、`fix: …`、`docs: …`）。

## 跨插件约定

左栏、设计语言、设置协议等跨插件约定的修改，请先到 [pi-shizuku](https://github.com/AoShizuku/pi-shizuku) 提 Issue 讨论。

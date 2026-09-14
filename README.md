# Local ChatGPT Archive Viewer

纯本地的 ChatGPT 导出档案查看器。数据在浏览器本地解析，不上传到服务器。

## 使用

直接打开 `index.html` 即可使用；也可以在项目目录启动本地静态服务器：

```sh
python3 -m http.server 8766
```

然后访问 <http://127.0.0.1:8766/>。

支持导入：

- ChatGPT 的 `.json`、`.zip`，以及内容为 JSON 的 `.js` 文件
- Gemini 导出的 JSON、无后缀 JSON 和 ZIP
- Claude 导出的 ZIP

右上角菜单提供导入、合并和导出功能。合并会在当前窗口生成合并后的对话，导出时再保存合并结果。

## 主体文件

- `index.html`：页面语义结构与挂载点
- `src/main.js`：应用状态、导入、交互和导出逻辑
- `src/data/archive-adapter.js`：ChatGPT 导出数据解析
- `src/ui/conversation-view.js`：对话、日期、编辑态渲染
- `src/ui/markdown.js`：Markdown 渲染
- `src/ui/icons.js`：本地图标渲染
- `src/styles/`：tokens、shell、conversation、composer、overlays 样式
- `scripts/build-standalone.mjs`：生成独立 `app.js`
- `reference/`：本地证据包、契约和迁移记录

`src/vendor/katex/` 包含本地 LaTeX 渲染运行时和字体资源。

## 构建

```sh
node scripts/build-standalone.mjs
node --check app.js
```

构建脚本会：

- 按依赖顺序把 `src/` 模块生成到 `app.js`
- 将运行时代码、CSS、KaTeX、字体和 SVG 精灵资源嵌入 `index.html`
- 生成可直接通过 `file://` 打开的本地页面

源码编辑应优先修改 `src/` 和 `styles.css`，然后重新运行构建脚本。`app.js` 与 `index.html` 中的运行时代码和样式属于生成结果，不作为主编辑入口。

构建后建议执行：

```sh
node --check app.js
```

语法检查不能代替浏览器交互检查；涉及导入、弹窗、响应式布局或触屏行为时，应在窄屏尺寸下实际验证。

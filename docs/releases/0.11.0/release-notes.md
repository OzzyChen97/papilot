# Papilot 0.11.0

> Draft: 0.11.0 has not been published. Final release CI, native installers, npm and update assets still need verification.

Write with Papilot Writer, keep an Overleaf project in sync, and annotate and review on a redesigned PDF canvas. This release also brings paper templates, reading anchors, more agent integrations, and experimental incremental compilation.

![The PDF canvas showing a typeset before-and-after change beside its note](https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/assets/readme-showcase/hero.png)

*Workspace illustration. Feature screenshots below use sample papers and demo accounts.*

## Papilot Writer

**Papilot Writer is a built-in agent for manuscript work.** It searches the paper, follows its outline and references, and uses a paper map derived from compilation. The conversation shows file edits inline, locates changes by section or PDF passage, and exposes a breakdown of the context sent to the model. Provider setup is available inside Papilot. ([#166](https://github.com/PapilotAI/papilot/pull/166), [#180](https://github.com/PapilotAI/papilot/pull/180))

Sign in with ChatGPT or GitHub Copilot, or connect a provider with an API key. Claude in Writer requires an Anthropic API key. Writer keeps its credentials separate from the native Pi CLI; provider subscriptions and API usage are not included with Papilot.

![Papilot Writer provider setup with ChatGPT, GitHub Copilot and API-key providers](https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/releases/0.11.0/images/writer.png)

*Connect your model provider inside Writer.*

## Work with Overleaf coauthors

**Link a paper to Overleaf and sync while Papilot runs.** Applied edits, incoming text changes, and file creation, renaming and deletion travel both ways. Papilot shows coauthors' cursors and source changes, uses Overleaf's selected main file and compiler, and reconnects after interruptions. Sign in through Overleaf's own page in the desktop app, reuse a supported browser session, or provide a session cookie. Self-hosted Overleaf servers are supported. ([#212](https://github.com/PapilotAI/papilot/pull/212), [#214](https://github.com/PapilotAI/papilot/pull/214))

After time apart, conflicting passages keep Overleaf's text and retain your version for **Use mine**. Read-only and review-only access can receive changes but cannot upload local edits. Build output, secrets and ignored new files stay local; files over 50 MB and unsupported names are listed as not synced. See [setup and sync limits](https://github.com/PapilotAI/papilot/blob/main/docs/guide.md#sync-with-overleaf).

![Overleaf sync panel showing coauthors and a passage changed on both sides](https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/releases/0.11.0/images/overleaf.png)

*See who is editing and choose which version of a conflicting passage to keep.*

## A clearer workspace for reading and review

- **A PDF canvas with consistent controls.** Floating marking tools, compact panels and menus, clearer review actions, and coordinated light and dark themes work across desktop and phone layouts. The app, website and Mac installer also have a new Papilot icon and updated artwork. ([#211](https://github.com/PapilotAI/papilot/pull/211), [#215](https://github.com/PapilotAI/papilot/pull/215), [#209](https://github.com/PapilotAI/papilot/pull/209), [#218](https://github.com/PapilotAI/papilot/pull/218))
- **Reading anchors and margin cropping.** Save named reading positions that follow TeX source after recompilation, and crop the displayed margins for easier reading on a phone. Crops stay on this device and leave exported PDFs unchanged. Reading controls and keyboard navigation are simpler. ([#205](https://github.com/PapilotAI/papilot/pull/205), [#195](https://github.com/PapilotAI/papilot/pull/195), [#207](https://github.com/PapilotAI/papilot/pull/207))
- **Send a section's comments to a task.** Choose a section and its nested subsections in **My notes → Add to task**, then adjust individual selections before sending. A compiled outline or PDF bookmarks provides the section hierarchy. Grouping runs without blocking new annotations or source lookup. ([#176](https://github.com/PapilotAI/papilot/pull/176), [#221](https://github.com/PapilotAI/papilot/pull/221))
- **Manage tasks together.** Archive or delete tasks in bulk with progress and retry support. Choose another agent through the model menu to restart the original request in a linked replacement task; choosing another model on the same agent keeps the conversation. ([#199](https://github.com/PapilotAI/papilot/pull/199), [#201](https://github.com/PapilotAI/papilot/pull/201))

<p>
  <img src="https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/releases/0.11.0/images/crop-editor.png" alt="Crop margins on a phone by dragging the four edges" width="300">
  <img src="https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/releases/0.11.0/images/crop-reading.png" alt="The same sample paper after applying the margin crop" width="300">
</p>

*Adjust the margins, then read the same paper with more room for its content.*

## Start and organize papers

- **Templates, blank papers and imports share one flow.** Browse [Papilot Universe](https://papilot.ai/universe/) templates, start from the bundled example, or import source from arXiv, Overleaf sharing links, public GitHub repositories and HTTPS archives. Template selection retains drafts and offers recovery when the catalog is unavailable. ([#185](https://github.com/PapilotAI/papilot/pull/185), [#198](https://github.com/PapilotAI/papilot/pull/198), [#202](https://github.com/PapilotAI/papilot/pull/202), [#203](https://github.com/PapilotAI/papilot/pull/203))
- **Open a folder or import a copy explicitly.** Folder pickers and clearer labels distinguish editing originals from copying them. Local folder and ZIP uploads stream to disk without the former 64 MiB / 5,000-file caps. ([#208](https://github.com/PapilotAI/papilot/pull/208))
- **Compile different documents in one repository.** Browse source files and switch between a paper, slides or response letter. Each document keeps its build settings, notes and reading position; an existing task stays with the document it was created for. ([#188](https://github.com/PapilotAI/papilot/pull/188))

![New paper template gallery with example, NeurIPS, ICML, ICLR, CVPR and ECCV papers](https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/releases/0.11.0/images/templates.png)

*Browse real template previews without leaving the new-paper dialog.*

## More agents and opt-in experiments

**Native Pi, Qoder, CodeBuddy and WorkBuddy integrations** extend the model menu and setup diagnostics. Native Pi requires Pi 1.5.1 or newer and uses its own providers, skills and extensions. WorkBuddy requires an explicitly configured compatible ACP launcher; desktop login alone is insufficient. Qoder, CodeBuddy and WorkBuddy do not provide a verified read-only mode here, so AI reviews and helper generations require another supported agent. See [agent setup and validation limits](https://github.com/PapilotAI/papilot/blob/main/docs/guide.md#agents). ([#197](https://github.com/PapilotAI/papilot/pull/197), [#210](https://github.com/PapilotAI/papilot/pull/210))

Two features are off by default in **Settings → Experiments**:

- **Compile with PhiTeX.** Reuse incremental compiler state between builds while keeping each review's output stable. Install PhiTeX separately on the Papilot host; it has its own license and still needs a TeX installation. LuaLaTeX papers and existing chapter-only reviews retain latexmk. New PhiTeX comparisons compile the whole document without individual-pass previews; custom latexmk rules are unsupported, and XeLaTeX support is less complete with a slow initial font index. See [PhiTeX setup and limitations](https://github.com/PapilotAI/papilot/blob/main/docs/guide.md#compile-with-phitex-experimental). ([#222](https://github.com/PapilotAI/papilot/pull/222))
- **Collaboration mode.** Codex coordinates selected workers for quick edits, polishing, and checks and reasoning. Isolated edits are integrated and a separate Codex pass audits annotation coverage, with worker activity visible in the chat. Workers are limited to selected existing text files; model audits do not guarantee correctness. See [setup and limitations](https://github.com/PapilotAI/papilot/blob/main/docs/annotation-routing.md). ([#204](https://github.com/PapilotAI/papilot/pull/204))

![Experiments settings with PhiTeX enabled and separate collaboration worker choices for three roles](https://raw.githubusercontent.com/PapilotAI/papilot/407b9f9a1008b7d24e2920b7dc5b85c37cd15fb4/docs/releases/0.11.0/images/experiments.png)

*Opt into incremental compilation and choose who handles each kind of annotation.*

## Fixes that keep work moving

- A review becomes ready when its main comparison is ready. Optional wording previews load in the background without delaying review, application or commit. ([#219](https://github.com/PapilotAI/papilot/pull/219))
- Recoverable LaTeX errors can produce a usable PDF with diagnostics throughout the review flow. Fatal errors still fail; enable `halt_on_error` in the document's settings to stop at the first error. Commented Unicode examples no longer select the wrong TeX engine. ([#206](https://github.com/PapilotAI/papilot/pull/206), [#123](https://github.com/PapilotAI/papilot/pull/123))
- AI review reads extracted PDF text from a file, allowing focused reviews of long theses without overflowing Codex's initial-message limit. ([#189](https://github.com/PapilotAI/papilot/pull/189))
- On native Windows, Claude and GLM start with supported permissions, MiKTeX source paths map correctly, and Codex releases task and helper conversations so deletion, titles and commit messages can finish. ([#169](https://github.com/PapilotAI/papilot/pull/169), [#172](https://github.com/PapilotAI/papilot/pull/172), [#183](https://github.com/PapilotAI/papilot/pull/183), [#186](https://github.com/PapilotAI/papilot/pull/186))
- Contents, page counts and search recover when applied edits replace a PDF. Fully reviewed paused tasks can be applied or committed without restarting the agent. ([#181](https://github.com/PapilotAI/papilot/pull/181), [#173](https://github.com/PapilotAI/papilot/pull/173))
- Managed installations can disable in-app updates and runtime agent downloads; diagnostics identify dependencies that belong in the deployment. ([#190](https://github.com/PapilotAI/papilot/pull/190))

## Installation and updates

After publication:

- **Desktop:** use **Settings → Updates**, or the matching release asset: macOS Apple Silicon/Intel DMG or ZIP, Windows x64 installer/portable executable, or Linux x64 AppImage/deb. Desktop updates use the desktop release assets.
- **CLI/server:** run `npm install -g papilot@0.11.0` with Node.js 22.22 or newer, then restart Papilot. npm updates the CLI/server installation.
- **Managed deployments:** rebuild the image or upgrade the package through its deployment system.

Compiling papers requires Git and a TeX distribution on the host running Papilot. Configure your chosen agent or Writer provider for AI tasks. Overleaf sync, PhiTeX and collaboration mode require their own setup; updating does not enable the experiments.

## Thanks

Thanks to the contributors who helped deliver this release:

- @chengluyu for Papilot Writer ([#166](https://github.com/PapilotAI/papilot/pull/166)).
- @jiangsy for clearer imports and streamed uploads ([#208](https://github.com/PapilotAI/papilot/pull/208)).
- @klklkl2405 for ignoring commented Unicode engine hints ([#123](https://github.com/PapilotAI/papilot/pull/123)).
- @RIvance for making halt-on-error optional ([#206](https://github.com/PapilotAI/papilot/pull/206)).
- @YJW2000 for Qoder, CodeBuddy and WorkBuddy integrations ([#210](https://github.com/PapilotAI/papilot/pull/210)).

Thanks also to @Lilacio for the Windows Claude report ([#167](https://github.com/PapilotAI/papilot/issues/167)), @liutong6149 for MiKTeX mapping ([#171](https://github.com/PapilotAI/papilot/issues/171)), @FangWX22H for document selection feedback ([#175](https://github.com/PapilotAI/papilot/issues/175)), @lzhqw for PDF navigation and task deletion reports ([#178](https://github.com/PapilotAI/papilot/issues/178), [#179](https://github.com/PapilotAI/papilot/issues/179)), and @cylixlee for the native Pi request ([discussion #192](https://github.com/PapilotAI/papilot/discussions/192)).

[Detailed changelog](https://github.com/PapilotAI/papilot/blob/v0.11.0/CHANGELOG.md) · [All changes since 0.10.4](https://github.com/PapilotAI/papilot/compare/v0.10.4...v0.11.0)

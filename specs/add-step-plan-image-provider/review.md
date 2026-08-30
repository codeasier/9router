# 审阅: specs/add-step-plan-image-provider

> 两版审阅合并（glm-5.2 会话 + deepseek-v4-flash 会话，2026-08-01）。问题按严重程度编号，均附 `file:line` 证据。

## 结论

**高质量、可直接进入实现阶段。** 两版审阅均逐项核对了 spec 对代码库的描述，未发现事实性错误。设计决策大多必要且合理。修订下列问题（#1–#4 必须，其余建议）后实施。

## 已核实的代码库准确性（spec 正确的部分）

- **registry 形态**：实际 image provider 用**顶层** `serviceKinds`/`imageConfig`，而非 `REGISTRY_TEMPLATE.js:77-85` 里过时的 `media:` 嵌套——spec 跟随了真实条目（`black-forest-labs.js:30-31`、`recraft.js:22-23`），正确。
- **模型 `kind:"image"`**：实际条目用 `kind`（`black-forest-labs.js:23`），`getModelKind` 读 `m?.kind || m?.type`（`src/shared/constants/models.js:40`）。spec 正确；template 注释里的 `type:` 才是过时的。
- **`normalizeModel` 透传**：`open-sse/providers/models/schema.js:22-26` 用 `{...model}` 展开，不会剥离 `paramConfig`/`params`——dashboard 设计可行。
- **模型发现链路**：`PROVIDER_MODELS` 由 registry 构建（`open-sse/providers/index.js:39`），image-only provider **无需** `config/providerModels.js` 条目——spec 的 Impacted Areas 正确地省略了它。
- **registry 新增即自动出现在 dashboard 与 API-key 创建路径**：`src/shared/constants/providers.js:2` 由 REGISTRY 派生，`category:"apikey"` → `APIKEY_PROVIDERS`，`getProvidersByKind("image")` 自动覆盖，无需改静态常量。
- **image handler/route 无需改动**：`src/sse/handlers/imageGeneration.js:70-141` 的凭据循环、`x-connection-id`、`handleComboChat` 全部 provider 无关；`imageGenerationCore.js` 通过 `getImageAdapter` 分发。
- **adapter 抛错->400**：`imageGenerationCore.js:98-104` 捕获 `buildBody`/`buildUrl`/`buildHeaders` 抛错并返回 400，**在 fetch 之前**——spec 的本地校验方案可行。
- **invalid-JSON 2xx->502**：`imageGenerationCore.js:185-186`，与 R8 一致。
- **无 index 生成器**：`scripts/` 下 `injectDisplayToRegistry.mjs`/`migrate-registry.mjs` 均不重建 `registry/index.js`（migrate 只重写单个文件，`filter(f => f !== "index.js")`），spec 说"无可用生成器"准确，手工 append（p100，当前 p0–p99）是正确做法。
- **校验路由走通用 media 探测**：`src/app/api/providers/validate/route.js:46-81` `probeMediaProvider` 已按 `authHeader:"bearer"` + `cfg.method`（支持 GET）构造请求；`imageConfig` 整体透传（`open-sse/providers/index.js:23-28`），新增 `validateUrl` 字段可行。
- **现有 media 探测语义**：当前 `res.status !== 401 && !== 403`（500 也判有效）；规格要求的严格 2xx 语义必须按"是否配置 validateUrl"分支（见 #3）。

## 优点

1. **正确识别了 dashboard 全局默认值泄漏这个真实 bug**（见 #1）。
2. `paramConfig` 设计是**通用机制**而非 `providerId === "step-plan"` 分支，且确实必要——因为 `seed`/`steps`/`cfg_scale`/`negative_prompt`/`text_mode` 不在全局 `KIND_EXAMPLE_CONFIG.image.extraFields` 里（`exampleShared.js:43-52`），不加 `paramConfig` 这些字段根本无法渲染。
3. 校验值保留（falsey/0/""）的明确要求，避免常见 truthiness bug。
4. "height×width 当不透明枚举"的警告防止误用 `sizeToAspectRatio`（`_base.js:9-19`）这类通用助手。
5. 凭据校验严格 2xx + 显式保留 legacy probe 行为，非回归边界清晰。
6. Scope 闭环（Impacted Areas 白名单 + Out of Scope 显式列出）。

## 需要修正/补充的问题

### 1. [重要] dashboard 重构对**存量** image provider 的线上请求体有行为变更，spec 描述不足

当前 `GenericExampleCard.js:53-55` 用**全局** `extraFields` 初始化 `extraValues`（含 `quality:"auto"`、`background:"auto"`、`image_detail:"high"`、`output_format:"png"`），而请求体构造 `:108-121` 把**所有非空** `extraValues` 都塞进去——**不**按 `params` 过滤。这意味着 flux/recraft 等**今天就在向上游泄漏** `quality`/`background`/`output_format`。

spec 的 task 2（"only resolved fields declared by the selected model"）是**通用**改动，会让所有 image model 不再发送未声明的字段。spec 在 `:304` 和 checklist `:76` 提到了"may affect other media model examples / controls continue to render"，但这只覆盖**渲染**，没说**请求体会丢掉泄漏字段**。

**建议**：spec 显式声明这是有意的新行为，并在 task 9 增加断言——选一个存量模型（如 flux，`params:["n","size"]`）证明它**保留** n/size 且**不再发送** quality/background/output_format。否则审阅者无法判断"丢字段"是预期还是回归。

### 2. [重要] validateUrl 的 fallback 措辞自相矛盾

`spec.md:170` 写 *"honor validateUrl/validateMethod **before falling back to probing the service endpoint**"*，但 Scenario: Validation Service Failure（`spec.md:267`）又明确 *"does not fall back to an image-generation probe"*。

**建议**：明确——**配置了 validateUrl 时它就是唯一探测目标，无任何回退**；fallback 仅适用于无校验元数据的 legacy provider。否则实现者可能写出"validateUrl 失败→再探测 baseUrl（=生成端点）"的错误逻辑。

### 3. [中] 严格 2xx 语义的作用范围需明确

checklist `:59` 已写 "Other non-2xx... never reported as valid"，但正文只在 Step Plan 语境下描述。当前 `probeMediaProvider` 的语义是 401/403 之外一律有效（`route.js:80`）。

**建议**：明确——**只有配置了 validateUrl/validateMethod 的 media provider 采用严格 2xx**，未配置的走原有 401/403 语义；并为此加一条回归测试（checklist `:60` 已覆盖，建议提升为必测断言）。

### 4. [中] task 11 的 handler 层测试缺脚手架，工作量被低估

task 11 要求 handler 级测试（local API key、preferred connection、多账号 fallback、combo、binary）。但现有 `tests/unit/image-generation.test.js` 只测 **core**（`handleImageGenerationCore`），**没有** `src/sse/handlers/imageGeneration.js` 的测试。该 handler 依赖 `getProviderCredentials`/`getSettings`/`getModelInfo`/`getComboModels`（auth/db/model 服务，`imageGeneration.js:1-15`），属 app 侧（`src/sse/`），mock 面比 engine 侧大。

spec 的测试范围写的是"using existing test locations where available"——对 handler 层**不存在**现成位置。

**建议**：spec 注明 task 11 需新建 `vi.mock` 脚手架并指出依赖面，或把 handler 级 fallback/combo 测试降级为"best-effort，core 层全覆盖 + handler 层尽力"。

### 5. [小] "Dashboard Request" scenario 字段列举不完整

`spec.md:257-259` 列了 model/prompt/n/size/steps/cfg_scale，但按 paramConfig 默认值和 checklist `:66`，默认请求**还**包含 `response_format:"url"` 和 `text_mode:false`。scenario 的"contains no unsupported field"正确，但枚举集与 checklist 不一致。

**建议**：scenario 标注为"illustrative"或补全字段，避免实现者以 scenario 为唯一基准。

### 6. [小] `imageConfig`/`serviceKinds` 位置表述歧义

`spec.md:78-82` 平铺列出 `serviceKinds`、`imageConfig.baseUrl` 等，未明说"顶层"。实现者若参考 `REGISTRY_TEMPLATE.js:77-85` 的 `media:` 嵌套会写错。

**建议**：加一行说明"顶层声明，与现有 image provider 一致；template 的 `media:` 块已过时"。

### 7. [小] `validateMethod` 与既有 `method` 字段重复

`probeMediaProvider` 已读 `cfg.method`（`route.js:73`）。spec 新增 `validateMethod`。可接受（校验端点独立配置），但 Step Plan 校验只可能是 GET。

**建议**：考虑"有 `validateUrl` 即默认 GET"以减少配置面，或显式说明为何不复用 `method`。

### 8. [小] registry 条目未规定 `priority` 与完整 `display`

存量 image provider 设 `priority`（`black-forest-labs.js:3`、`recraft.js:3`）和完整 `display`（icon/color/textIcon/website）。spec `:136-160` 只给了 model 对象和 display name+apiKeyUrl。

**建议**：要么给 `priority` 一个值或显式"省略"，`display` 至少建议 icon/website，减少实现者猜测。

### 9. [小] `paramConfig` 合并语义需钉死"数组整体替换"

`spec.md:121` 全局定义与 `paramConfig[key]` 的浅合并，`options` 数组被整体替换——对 `response_format`（全局含 `""`、模型不含）效果正确。

**建议**：实现时用测试钉死"数组整体替换、不逐元素合并"，防止误实现。

### 10. [小] boolean 控件与 disabled 固定值为新增能力，需配套测试

当前 `GenericExampleCard.js:397-430` 只渲染 select/text/number，`text_mode` 的 checkbox 渲染、以及 `min===max` 的 disabled 固定值（`spec.md:162`）都是新行为，对应 tasks.md 第 1 项。

**建议**：为这两项各加一条 dashboard 测试（规格已列，实施时勿略）。

### 11. [小] `n` 类型严格性测试建议

spec 说 "reject any supplied value other than integer 1"。

**建议**：测试覆盖 `n:"1"`（字符串）与 `n:1.0` 的拒绝路径，避免实现时用宽松 `== 1` 比较。

### 备注（无需处理）

- `Content-Type: application/json` 随 GET 校验请求发出（现有 `probeMediaProvider` 已如此）——对 StepFun 无害，保持即可。
- AGENTS.md:44 的 "add models to config/providerModels.js" 已过时（本 checkout 由 registry 驱动），本规格未触碰 `config/providerModels.js`，与现状一致。

## 确认可行、无需改动的设计点

- `n` 默认 1、拒绝非 1：dashboard `paramConfig` min=max=1（禁用固定值）+ adapter `buildBody` 抛错->400，双保险一致。
- `buildBody` 在 401/403 重试时被调用两次（`imageGenerationCore.js:100` 与 `:141`）：校验失败时第一次抛错已在 `:102-104` 返回，重试路径不可达，"must not issue a fetch"成立。
- step-plan 与既有 `commandcode.js:41` 的 `stepfun/Step-3.5-Flash` 模型串无冲突（不同 provider）。
- alias baseline `aliasToId` 加 `"step-plan":"step-plan"` 即可（`alias-baseline.json`），task 12 可控；`providers-baseline.json` 连 recraft/bfl 都没有，image-only provider 大概率不影响该快照，spec 已用"or any intentional diff is reviewed"对冲。

## 建议的最小修订

1. #1：声明存量 provider 请求体行为变更 + 加断言测试。
2. #2/#3：明确 validateUrl 唯一探测目标、严格 2xx 仅限配置了校验元数据的 provider，各加一条回归测试。
3. #4：注明 task 11 handler 层测试需新建 mock 脚手架。
4. #5/#6/#8：补全 scenario 字段、明确顶层声明、规定 `priority`/`display`。

除上述外，spec 可直接进入实现。

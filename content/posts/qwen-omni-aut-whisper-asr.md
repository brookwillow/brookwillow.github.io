---
title: "从 Qwen2.5-Omni AUT 表征到 Whisper Decoder：一次车载 ASR 旁路实验复盘"
date: 2026-05-31T22:36:21+08:00
tags: ["AI", "语音"]
draft: false
---

车载语音助手里，端到端 Omni 模型有一个很吸引人的方向：用户说话后，不再先跑独立 ASR 再把文本送进大模型，而是直接让多模态模型从音频输入生成工具调用或自然语言回复。这样做的好处很明显——减少级联系信息损失，语音里的停顿、语气和上下文也能被模型利用。

但端到端也有一个很现实的短板：如果模型直接吃音频输出工具调用，中间就没有一份稳定的 ASR 文本。没有 ASR 文本，后续很多工程能力就会变得困难——对话历史落盘、日志排查、长期记忆、RAG 预召回、训练数据标注，全都需要一个"用户到底说了什么"的文本锚点。

所以我们开始尝试一条旁路：能不能从 Qwen2.5-Omni 的音频编码器（Audio Tower，简称 AUT）里取出隐藏表征，再接一个 Whisper decoder，把 ASR 文本解出来？不需要额外跑一个完整的 ASR encoder，只复用 Omni 推理过程中已经算好的东西。

## 为什么要一份显式 ASR 文本

当前服务的核心链路是 Qwen2.5-Omni 接收文本或音频，输出车控工具调用 JSON 或自然语言回复。对线上推理来说，只要工具调用正确，链路就是成立的。

但从系统工程角度看，一份可读的文本输入能解决很多问题：

- **对话历史落盘**：需要用户具体说了什么，才能 append 到多轮对话上文里。
- **日志审计**：不能只存音频和最终 JSON，需要知道用户说了什么。
- **长期记忆**：需要抽取事实和偏好，比如"用户喜欢主驾座椅偏后"。
- **RAG 预召回**：通常依赖文本 query，音频直接召回成本更高。
- **训练数据闭环**：依赖 ASR 文本完成用户数据的初步标注。

## 第一次尝试：直接接上试试

最直接的想法：把 AUT 的输出当成 Whisper encoder 的输出，直接喂给 Whisper decoder。

做法是加载 Qwen2.5-Omni 模型，在 AUT 的 `ln_post` 层上挂一个 forward hook，对输入音频跑一次推理，捕获这一层的 hidden states，然后包装成 Whisper decoder 期望的 `encoder_outputs` 格式，调 Whisper large-v3 decoder 做 transcribe。

选择 `ln_post` 的原因很简单——它的 hidden size 是 **1280**，和 Whisper large-v3 的 `d_model=1280` 完全对齐。形状上没毛病：

```text
[probe] hidden shape=(1, 36, 1280)
[probe] encoder_hidden dim=1280, whisper d_model=1280
```

张量链路是通的。但通不等于能用。

## 对齐的是维度，没对齐的是空间

1280 维只是入场券。下面这些东西一个都没对上：

- **时间长度**：AUT 的 `ln_post` 输出只有 36 个时间步，而 Whisper encoder 的输出和音频长度成正比（每 2 秒约 50 步，30 秒约 750 步）。对短车控指令来说，`ln_post` 的时间密度比 Whisper 更稀疏，导致 decoder cross-attention 能看的时间位置偏少。
- **表征分布**：均值、方差、方向、token 间相关性在 Omni 训练后都发生了漂移。
- **位置语义**：同样是第 20 个 hidden，未必对应 Whisper encoder 里同一段音频区域。
- **训练目标**：Whisper encoder 服务于 ASR，Qwen AUT 在 Omni 里服务于多模态理解和后续 LLM 推理。
- **decoder 条件空间**：Whisper decoder 训练时看到的是 Whisper encoder 的输出分布，不是 Qwen AUT 经过 Omni 训练后的输出分布。

一句话：**对齐的是 1280 维通道数，没对齐的是时间轴、表征分布、位置语义和 decoder 熟悉的编码器条件空间。**

另外有一个容易混淆的点：Qwen2.5-Omni 的 AUT 确实跟 Whisper 有很强关系，参数很可能来自 Whisper 初始化。所以直接接 Whisper decoder 偶尔能出字——这是"表征亲缘性"的体现。但初始化相同不代表训练结束后仍然兼容。Omni 训练把 AUT 表征推向了更适合 LLM 消费的空间，而不是保持 Whisper encoder 的 ASR 条件分布。

## 直接解码的效果：能出字，但不稳定

实际跑车载 eval 音频，出现了几类典型现象：

"部分接近但有错字"：

```text
[ASR result] 打开车窘    ← 应该是"打开车窗"
```

说明 AUT hidden states 里确实有语音内容，但表征空间不是 Whisper 原生的那个空间。

"重复退化"：

```text
[ASR result] 好 来 来 来 来 来 来 来 来 来 来 ...
```

decoder 没有稳定 encoder 语义约束时的典型表现——能进入高频 token 区域，但停不下来。

还有空输出、语种漂移（"再開一點"）、乱码数字（"50"）等。这些都指向同一个结论：维度相同只是最低要求，decoder 真正依赖的是训练时见过的 encoder 表征分布。

> **第一阶段结论**：AUT hidden states 可以被捕获，也能驱动 Whisper decoder 产生非随机文本；但直接拼接不够稳定，不能作为可用 ASR 链路。

这个结论否定了"直接拼起来就能用"，但保留了"通过少量训练做空间对齐"的可能。

## 换一层 Hook：`ln_post` 不是唯一选择

第一版选 `ln_post` 纯粹因为维度刚好。后来把所有 AUT 内部层的 shape 都打了出来，发现了一个关键信息：

```text
audio_tower.conv1              [1,1280,144]
audio_tower.conv2              [1,1280,72]
audio_tower.layers.0~31        [72,1280]
audio_tower.avg_pooler         [1280,36]
audio_tower.ln_post            [36,1280]
audio_tower.proj               [36,2048]
```

`ln_post` 已经过了 `avg_pooler`，时间步从 72 被压缩到了 36。而 `audio_tower.layers.31` 的输出是 `[72, 1280]`——时间步翻倍，维度不变。

于是把 hook 从 `ln_post` 切到 `layers.31`。直接接 Whisper decoder 的结果仍然是退化（`cakescakes...éta...`）。这说明了一个更深层的问题：**帧数对齐和 hidden size 对齐只是入场券，真正难点始终是表征分布对齐。**即使给你更多帧，decoder 不认识的分布照样不认识。

## Bridge：只训练一个小映射层

既然直接拼不行，下一步就是加一个轻量映射层。思路很克制：Qwen 和 Whisper 全部冻结，只训练一个小的桥接模块，把 AUT hidden space 映射回 Whisper decoder 更熟悉的 encoder space。

Bridge 的结构很简单：

```text
LayerNorm → Linear(dim → hidden_dim) → GELU → Dropout → Linear(hidden_dim → dim) → Residual → LayerNorm
```

从轻到重的设计逻辑：

- 最小版本：一个 `Linear`。如果差异只是旋转、缩放或偏移，线性层就够。
- `LayerNorm + Linear`：不同音频的 hidden mean/std 差异大，先拉齐统计量再做投影更容易收敛。
- 小 MLP 加残差：覆盖轻微非线性漂移，同时参数少，不会被少量 ASR 样本过拟合。
- `repeat_factor`：粗粒度补偿时间密度不足，能快速验证"时间不够"是不是主要瓶颈。

训练时 loss 直接来自冻结的 Whisper decoder：缓存 AUT hidden → bridge 映射 → 包装成 `BaseModelOutput` → Whisper decoder 解码 → 用真实 query 做 labels → 只反传 bridge 参数。bridge 不需要学语言模型，只学一个分布对齐。

## `layers.31 + bridge`：转折点

有了 shape 分析的结论后，改用 `layers.31` 作为 hook 层重新训练 bridge。当前效果最好的一组配置：

- hook 层：`audio_tower.layers.31`，输出 `[72, 1280]`
- bridge hidden dim：2048
- dropout：0.02
- repeat_factor：1（不再硬补时间）
- 训练轮数：7 epochs

和早期 `ln_post` 路线相比的关键变化：时间步从 36 翻倍到 72，bridge 容量从 1280 提到 2048。

结果很直接——短指令完全转写：

```json
{"query": "通话音量调到最大", "asr": "通话音量调到最大"}
{"query": "能量回收调大", "asr": "能量回收调大"}
{"query": "大灯切换到自动模式", "asr": "大灯切换到自动模式"}
{"query": "导航音量调大一点", "asr": "导航音量调大一点"}
{"query": "关闭车窗", "asr": "关闭车窗"}
```

长指令也能保留主要语义和槽位：

```json
{"query": "屏幕亮度拉到最低，音量也调小一点", "asr": "屏幕亮度拉到最低音量也调小一点"}
{"query": "前面路况好，给我来点推背感", "asr": "前面路况好给我来电推背感"}
{"query": "关闭第二排左侧无线充电", "asr": "关闭第二排左侧充电"}
```

这足以说明：AUT 表征里保留了大量的 ASR 信息，失败不是因为信息丢了，而是 Whisper decoder 不认识 Omni 训练后的表征空间。一个很小的 bridge 就能把信息重新对齐回来。

当然问题也还在：同音/近音字（"保鲜"→"保先"）、长指令丢槽位（"无线"、"方向盘加热"）、个别异常字符。作为对比，`layers.23` 在同样配置下整体更差，截断和重复更多。

> **当前结论**：`layers.31 + bridge` 已经证明 AUT 表征可以被重新对齐到 Whisper decoder 条件空间。作为旁路 ASR、RAG 预召回和记忆落盘的技术路线是成立的。它暂时还不适合作为用户可见的 ASR 输出，但已经值得进入更系统的评估阶段。

## 为什么值得继续

这条路线的价值不在于替代 Whisper，而在于探索端到端 Omni 系统里"内部 ASR 旁路"的可能性：

- 不额外跑完整 ASR encoder，只复用 Omni 已经算过的 AUT 表征。
- 端到端工具调用之外，旁路生成一份可审计文本。
- 为长期记忆、RAG 召回、日志分析提供统一文本入口。
- ASR 文本与工具调用绑定到同一次模型推理的音频表征上，减少链路不一致。
- 训练成本低，只训一个小桥接层。

## 下一步

1. 把 `layers.31 + bridge_hidden_dim=2048` 这组配置固化为 baseline，记录完整配置和 eval 指标，避免后续实验不可复现。
2. 扩充音频到文本样本，尤其补长指令、多槽位、同音词、车载专有名词和用户偏好表达。
3. 建立车载关键词评估——工具触发词、设备名、位置、数值、方向、开关状态等 slot/value 的召回率，比字符相似度更有实际意义。
4. 约束异常输出——针对重复、乱码和过早截断加 decoding 约束或后处理。
5. 尝试更强的时间 resampler——在当前 baseline 上试小型 Conv、learned upsampling 或 cross-attention resampler。

---

这次实验把一个模糊问题拆成了可验证的路径：先证明表征能不能被捕获，再证明能不能直接解码，接着定位到时间步和表征空间不对齐，最后通过 `layers.31 + bridge` 证明轻量对齐确实有效。这正是端到端语音系统工程化最典型的状态：模型能力在黑盒里已经存在一部分，但要把它变成稳定、可观测、可复用的系统能力，还需要额外的接口、监督和评估。现在这条路已经从"能不能做"进入了"如何把它做稳"的阶段。

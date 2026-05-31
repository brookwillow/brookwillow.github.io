---
title: "从 Qwen2.5-Omni AUT 表征到 Whisper Decoder：一次车载 ASR 旁路实验复盘"
date: 2026-05-31T22:36:21+08:00
tags: ["AI", "ASR", "语音识别", "LLM", "端到端", "工程实践"]
draft: false
---

在车载语音助手里，端到端 Omni 模型有一个很有吸引力的方向：用户说话之后，不再先走独立 ASR，再把文本送给大模型，而是直接让多模态模型从音频输入生成工具调用或自然语言回复。这样可以减少级联系统中的信息损失，也能让模型利用语音里的停顿、语气和上下文。

但端到端也带来一个现实问题：如果模型直接吃音频并输出工具调用，我们中间没有一份稳定的 ASR 文本。没有 ASR 文本，后续很多工程能力都会变得困难，比如服务端日志排查、长期记忆落盘、RAG 预召回、用户偏好抽取、错误样本归因等。于是我们开始尝试一条旁路路线：能不能从 Qwen2.5-Omni 的音频编码器中取出隐藏表征，再接一个 Whisper decoder，把 ASR 文本解出来？

这篇文章记录的是这个方向从问题提出、直接尝试、失败现象到后续桥接训练脚本的实际进展。

## 起点：Omni 推理链路里缺少显式 ASR

当前服务的核心链路是 Qwen2.5-Omni 接收文本或音频输入，然后输出车控工具调用 JSON 或自然语言回复。对于线上推理来说，只要最终工具调用正确，链路就是成立的。

但从系统工程角度看，我们仍然希望得到一份"用户到底说了什么"的文本：

- 日志审计需要可读输入，不能只存音频和最终 JSON。
- 长期记忆需要抽取事实和偏好，例如"用户喜欢主驾座椅偏后"。
- RAG 预召回通常依赖文本 query，音频直接召回成本更高。
- 训练数据闭环需要知道错误来自 ASR、理解、工具选择还是参数填充。
- 多轮指令里，"再关掉吧""调低一点"这类省略表达，也需要借助文本化历史做分析。

最简单的办法是在线路旁边再跑一个独立 Whisper ASR。事实上，服务里也保留过 `--debug-asr` 调试模式，用本地 tiny Whisper 帮助排查音频解码问题。但这只是调试辅助，不是端到端模型内部表征的复用。

我们真正想验证的是：既然 Qwen2.5-Omni 已经有 Audio Tower（AUT），能不能直接复用它的音频表征，让 Whisper decoder 负责转写？

## 第一次实验：直接把 AUT hidden states 喂给 Whisper decoder

为此我们恢复并扩展了一个实验脚本：

```bash
python scripts/probe_asr_decoder.py \
  --model-dir /home/wangjie/.cache/modelscope/hub/models/Qwen/Qwen2.5-Omni-3B \
  --whisper-dir openai/whisper-large-v3 \
  --audio data/eval/audio/window/window_001.wav
```

这个脚本做了几件事：

1. 加载 Qwen2.5-Omni。
2. 找到模型里的 `thinker.audio_tower`。
3. 在 `audio_tower.ln_post` 上注册 forward hook。
4. 对输入音频跑 Qwen thinker，捕获音频隐藏状态。
5. 加载 Whisper large-v3。
6. 把捕获到的 hidden states 包装成 Whisper 的 `encoder_outputs`。
7. 调用 Whisper decoder 做 `transcribe`。

为什么选择 `audio_tower.ln_post`？因为它输出的是 1280 维 hidden states，正好和 Whisper large-v3 的 `d_model=1280` 对齐。脚本里也保留了 `avg_pooler` 和 `full` 选项，但 full audio tower output 常见维度是 2048，与 Whisper decoder 不匹配，直接接上大概率无效。

单条样本运行时，我们可以看到类似的中间信息：

```text
[probe] found audio tower: model.thinker.audio_tower
[probe] hook target: audio_tower.ln_post, expected dim=1280
[probe] input_features shape=(1, 128, 30000)
[probe] feature_attention_mask shape=(1, 30000)
[probe] hidden shape=(1, 36, 1280) dtype=torch.float32 mean=0.013238 std=0.606570
[probe] encoder_hidden dim=1280, whisper d_model=1280
```

这说明链路在张量形状上是通的。Qwen 的音频表征确实可以被捕获，也确实可以作为 Whisper decoder 的 encoder hidden states 输入。

但形状对齐不代表语义空间对齐。

## 1280 维对齐意味着什么——以及它没对齐什么

今天重新讨论后，需要把一个关键点说清楚：我们这里对齐的是 **hidden size**，也就是 Qwen AUT 输出和 Whisper large-v3 encoder 输出都可以落到 `1280` 维。

所以"能直接喂给 Whisper decoder"成立的只是张量最后一维的形状条件。它不代表下面这些东西已经对齐：

- **时间长度没有对齐**：AUT hidden 可能是 36、40、92 这种较短序列，而 Whisper encoder 的输出通常是更密的时间步表示。
- **hidden 分布没有对齐**：均值、方差、方向、token 间相关性都可能在 Omni 训练后发生漂移。
- **位置语义没有对齐**：同样是第 20 个 hidden，未必对应 Whisper encoder 语义里的同一段音频区域。
- **训练目标没有对齐**：Whisper encoder 服务于 ASR，Qwen AUT 在 Omni 里服务于多模态理解和后续 Thinker 推理。
- **decoder 条件空间没有对齐**：Whisper decoder 训练时看到的是 Whisper encoder 的输出分布，而不是 Qwen AUT 经过 Omni 训练后的输出分布。

一句话概括：**对齐的是 1280 维通道数，没对齐的是时间轴、表征分布、位置语义和 decoder 熟悉的编码器条件空间。**

## Whisper 初始化不等于仍然兼容 Whisper Decoder

另一个容易混淆的问题是：Qwen2.5-Omni 的 AUT 本身确实和 Whisper 有很强关系，参数可能来自 Whisper 初始化。这说明它不是一个完全陌生的音频编码器，直接接 Whisper decoder 能偶尔出字，也正是这个"表征亲缘性"的体现。

但初始化相同不等于训练结束后仍然兼容。Omni 训练会把 AUT 表征推向更适合 Thinker 消费的空间，而不是保持原始 Whisper encoder 的 ASR 条件分布。尤其是我们 hook 的 `audio_tower.ln_post`，它未必就是 Whisper decoder 训练时假设的最终 encoder hidden states。

## 直接解码的结果：能出字，但不稳定

实际跑 eval 里的 window 音频时，输出出现了几类典型现象。

第一类是"部分接近但有错字"：

```text
[ASR result] 打开车窘
```

这类结果说明 AUT hidden states 里确实含有语音内容信息，Whisper decoder 不是完全随机输出。但"车窗"被转成"车窘"，说明表征空间并不是 Whisper 原生 encoder 输出空间。

第二类是重复退化：

```text
[ASR result] 好 来 来 来 来 来 来 来 来 来 来 来 来 来 ...
```

这种是 decoder 没有得到足够稳定的 encoder 语义约束时很常见的退化。它能进入某个高频 token 区域，但无法正确停下来，也无法稳定跟随语音内容。

第三类是空输出：

```text
[ASR result]
```

这说明有些音频对应的 AUT 表征对 Whisper decoder 来说几乎不可用，或者强制解码提示与 encoder 表征之间没有形成有效条件。

第四类是短文本或语种风格漂移：

```text
[ASR result] 50
[ASR result] 再開一點
```

这些结果更能说明问题：维度相同只是最低要求，Whisper decoder 真正依赖的是 Whisper encoder 学出来的表征分布。Qwen AUT 的表征虽然含有语音信息，但它服务的是 Omni thinker 的多模态理解目标，不是 Whisper 的逐字转写目标。

因此，我们对第一阶段实验的结论是：

> Qwen2.5-Omni 的 AUT hidden states 可以被捕获，也能驱动 Whisper decoder 产生非随机文本；但直接接 Whisper decoder 不够稳定，不能作为可用 ASR 链路。

这个结论很重要。它否定的是"直接拼起来就能用"，但保留了"通过少量训练做空间对齐"的可能性。

## 批量 Probe：从单样本观察变成可统计实验

为了不只靠几条样本做判断，我们把 `probe_asr_decoder.py` 扩展成支持批量扫描 eval 文件：

```bash
python scripts/probe_asr_decoder.py \
  --model-dir /home/wangjie/.cache/modelscope/hub/models/Qwen/Qwen2.5-Omni-3B \
  --whisper-dir openai/whisper-large-v3 \
  --eval-file data/eval/window_test.json \
  --limit 20 \
  --output data/serve_logs/aut_asr_probe_window.jsonl
```

批量模式会读取 eval 样本里的 `query` 和 `query_audio`，逐条输出：

- 原始 query。
- ASR 结果。
- 是否为空。
- 是否重复退化。
- 字符级相似度。
- 捕获到的 hidden shape、mean、std。

这一步的价值不是为了证明效果已经可用，而是为了把"感觉不稳定"变成可以批量观测的现象。后续如果训练桥接层，也可以用同一批 eval 音频和指标做对比。

## 第二阶段：冻结 Qwen 和 Whisper，只训练轻量 Bridge

直接拼接不稳定后，下一步自然是加一个小的映射层。我们实现了 `train_aut_asr_bridge.py`，目标是训练一个 AUT-to-Whisper 的轻量桥接模块。

训练命令如下：

```bash
python train_aut_asr_bridge.py \
  --model-dir /home/wangjie/.cache/modelscope/hub/models/Qwen/Qwen2.5-Omni-3B \
  --whisper-dir openai/whisper-large-v3 \
  --eval-dir data/eval \
  --output-dir aut_asr_bridge_output \
  --epochs 3 \
  --grad-accum 8 \
  --bridge-dtype float32
```

这个脚本的设计原则是尽量克制：

- Qwen2.5-Omni 冻结。
- Whisper 冻结。
- 只训练一个小的 `AutAsrBridge`。
- 训练数据直接来自 eval 中已有的 `query + query_audio`。
- 默认保留 10% validation。
- 先缓存 AUT hidden states，避免每轮训练都重复跑 Qwen 音频编码器。

Bridge 结构也很简单：

```text
LayerNorm
Linear(dim -> hidden_dim)
GELU
Dropout
Linear(hidden_dim -> dim)
Residual Add
LayerNorm
```

### Bridge 结构为什么这么设计

Bridge 的目标不是重新训练一个 ASR 模型，而是学习一个窄任务：**把 Qwen AUT hidden space 映射回 Whisper decoder 更熟悉的 encoder space**。因此它应该从轻到重逐步加复杂度。

最小版本可以是一个 `Linear`。如果 AUT 和 Whisper encoder 的差异主要是通道旋转、缩放或偏移，线性层就足够表达。这个版本参数少、风险低，也最容易判断"是否只是表征基变了"。

`LayerNorm + Linear` 是更稳的起点。因为 probe 已经看到不同音频的 hidden mean/std 会有差异，而 Whisper decoder 对输入分布比较敏感。先用 LayerNorm 拉齐统计量，再做线性投影，通常比裸 Linear 更容易收敛。

小 MLP 用来覆盖轻微的非线性漂移。Omni 训练后的 AUT 不一定只是线性旋转到新空间，可能有非线性压缩或任务相关重排。两层 MLP 加残差可以表达这类变化，同时不会大到把少量 ASR 样本过拟合成一个独立 decoder 前端。

时间维上的 `repeat_factor` 是粗粒度补偿。AUT 输出序列明显比 Whisper encoder 输出更短时，decoder 的 cross-attention 可看的时间位置太少，容易空输出或重复。repeat 不是最终方案，但能快速验证"时间密度不足是不是主要瓶颈"。

更强的后续方案是 resampler，例如 1D Conv、learned upsampling、cross-attention resampler 或 Perceiver-style resampler。它们可以学习从 AUT 的短序列生成更适合 Whisper decoder 的时间序列，比固定 repeat 更合理，但也需要更多样本和更严格的验证。

建议保留三组对照：

```text
Whisper encoder + Whisper decoder          (上限)
Qwen AUT ln_post + Whisper decoder         (直接拼接 baseline)
Qwen AUT ln_post + Bridge + Whisper decoder (桥接方案)
```

如果第三组明显优于第二组，并逐步接近第一组，就能说明问题主要来自分布和时间对齐，而不是 AUT 丢失了 ASR 所需的信息。

训练时 loss 直接来自冻结 Whisper decoder：从缓存读取 AUT hidden states，经过 bridge 映射到 Whisper hidden space，包装成 `BaseModelOutput`，用真实 query 作为 labels，只反传 bridge 参数。

这样做的好处是训练目标明确：bridge 不需要学语言模型，也不需要学完整 ASR；它只需要把 Qwen AUT 表征对齐到 Whisper decoder 能理解的条件空间。

## 为什么这条路线值得继续

这条路线的价值不在于替代 Whisper 本身，而在于探索端到端 Omni 系统里"内部 ASR 旁路"的可能性。

如果它能工作，我们可以得到几个收益：

- 不额外跑完整 ASR encoder，只复用 Omni 已经计算过的 AUT 表征。
- 在端到端工具调用之外，旁路生成一份可审计文本。
- 为长期记忆、RAG 召回、日志分析提供统一文本入口。
- 将 ASR 文本与工具调用输出绑定到同一次模型推理的音频表征上，减少链路不一致。
- 训练成本较低，因为只训练小桥接层。

当然，目前这仍是实验路线，不是线上默认链路。`scripts/probe_asr_decoder.py` 和 `train_aut_asr_bridge.py` 都不是稳定线上入口。

## 当前阶段的真实结论

截至目前，已经完成的成果包括：

- 恢复单音频 AUT ASR probe。
- 支持批量扫描 eval 音频并输出 JSONL。
- 确认 `thinker.audio_tower.ln_post` 的 1280 维 hidden states 可以接入 Whisper large-v3 decoder。
- 观察到直接解码存在错字、空输出、重复退化和语种风格漂移。
- 实现了冻结 Qwen + 冻结 Whisper + 只训练 bridge 的训练脚本。
- 支持 hidden cache、10% validation、训练日志、metrics、sample prediction 和 checkpoint。

需要强调的是，我们还没有把这个 bridge 证明成可用 ASR 模块。当前最可靠的判断是：

> 直接接 Whisper decoder 不够好；但 AUT 表征包含语音内容，值得通过少量监督样本训练桥接层继续验证。

## 下一步

到今天为止，这条路线的判断可以更明确一些：

1. 直接拼接不是最终方案，因为它只满足 1280 维形状对齐。
2. Whisper 初始化提供了可迁移基础，但 Omni 训练后的 AUT 表征已经偏向 Thinker 消费。
3. 轻量 Bridge 是合理中间层，优先从 LayerNorm + Linear / 小 MLP / 时间 repeat 做最小验证。
4. 如果要进入可用阶段，需要用 eval 音频构造少量音频到文本样本，冻结 Qwen 和 Whisper，只训练 Bridge。
5. 评估不能只看单条文本，要看 CER、空输出率、重复率，以及车载意图关键词是否保留。

后续可以沿着四个方向推进：

1. **跑完整 bridge 训练**，观察 validation 上的字符相似度、空输出率和重复率是否明显改善。这里只看 loss 不够，必须看生成文本。
2. **比较不同 hook layer**。`ln_post` 目前是形状最合适的选择，但 `avg_pooler` 或 audio tower 中间层可能有不同的信息密度。中间层也许更接近声学内容，末层则可能更偏 Omni 任务语义。
3. **改进时间维对齐**。当前 `repeat_factor` 是简单 baseline，后续可以尝试小型 Conv、cross-attention resampler 或 learned upsampling，把 AUT 时间步映射到更适合 Whisper decoder 的长度。
4. **评估它在车载闭环中的价值**。即使 ASR 不是满分，只要能稳定转写出关键词、槽位和用户偏好，它对记忆落盘和 RAG 预召回也可能已经足够有用。

---

这次实验最大的收获不是"我们已经做出了一个 ASR"，而是把一个模糊问题拆成了可验证路径：先证明内部表征能不能被捕获，再证明能不能直接解码，最后把失败原因收敛到表征空间对齐，并落到一个小模型训练问题上。

这正是端到端语音系统工程化时经常遇到的状态：模型能力在黑盒里已经存在一部分，但要把它变成稳定、可观测、可复用的系统能力，还需要额外的接口、监督和评估。

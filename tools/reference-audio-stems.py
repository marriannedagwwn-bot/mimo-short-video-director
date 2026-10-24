"""参考片仿写（2026-10-24）：用本机 Bandit v2 Multi 把参考视频的音轨分成人声、音乐、音效三轨。

只读地使用 Bandit 安装目录（vendor.bandit 与 separate_audio.read_reflected），不改它的任何文件；
先核对 checkpoint 的 SHA-256，对不上就失败。用 Bandit 自带的 .venv/bin/python -I 运行。

输出（都在 --output-dir 里，48 kHz 浮点 WAV）：
  speech.wav / music.wav / sfx.wav  三轨
  no_bgm.wav                         原声减去音乐轨（人声＋音效）
  intervals.json                     每 0.25 秒一格，人声轨与音效轨响度高于 -30 dB 的时间段
最后在 stdout 打一行 JSON。

为什么要音效轨：10-23 实验发现「咕嘎」这类不说词的叫声会被分进音效轨，只转写人声轨会漏掉，
所以转写用「原声减去音乐轨」。
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

CHECKPOINT_SHA256 = "abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc"
SAMPLE_RATE = 48000
STEMS = ["speech", "music", "sfx"]
ACTIVE_DB = -30.0
CELL_SECONDS = 0.25


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def active_intervals(audio, rate):
    mono = audio.mean(axis=1)
    step = int(rate * CELL_SECONDS)
    flags = []
    for start in range(0, len(mono), step):
        chunk = mono[start:start + step].astype(np.float64)
        level = 20 * np.log10(np.sqrt(np.mean(chunk ** 2)) + 1e-9)
        flags.append(bool(level > ACTIVE_DB))
    spans, begin = [], None
    for index, flag in enumerate(flags + [False]):
        if flag and begin is None:
            begin = index
        if not flag and begin is not None:
            spans.append([round(begin * CELL_SECONDS, 2), round(index * CELL_SECONDS, 2)])
            begin = None
    return spans


def main():
    parser = argparse.ArgumentParser(description="Bandit v2 Multi 三轨分离（参考片仿写）")
    parser.add_argument("--bandit-dir", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    root = args.bandit_dir.resolve()
    checkpoint = root / "models" / "checkpoint-multi.ckpt"
    if sha256(checkpoint) != CHECKPOINT_SHA256:
        raise SystemExit("Bandit checkpoint 的 SHA-256 对不上，拒绝运行")
    sys.path.insert(0, str(root))
    from vendor.bandit.bandit import Bandit  # noqa: E402
    from separate_audio import read_reflected  # noqa: E402

    audio, rate = sf.read(args.input, dtype="float32", always_2d=True)
    if rate != SAMPLE_RATE or audio.shape[1] not in (1, 2) or len(audio) < 2 or not np.isfinite(audio).all():
        raise SystemExit("输入必须是 48 kHz、单声道或立体声的有限值 WAV")

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    torch.set_num_threads(4)
    model = Bandit(in_channels=1, stems=STEMS, fs=rate, n_bands=64, n_sqm_modules=8,
                   emb_dim=128, rnn_dim=256, rnn_type="GRU", mlp_dim=512, pad_mode="reflect")
    state = torch.load(checkpoint, map_location="cpu", weights_only=False)["state_dict"]
    model.load_state_dict({key.removeprefix("model."): value for key, value in state.items()
                           if key.startswith("model.")}, strict=True)
    del state
    model.eval().float().to(device)

    frames = len(audio)
    chunk, hop = 8 * rate, 4 * rate
    window = np.hanning(chunk + 1)[:-1].astype("float32")
    predicted = {name: np.zeros_like(audio) for name in STEMS}
    weight = np.zeros(frames, np.float32)
    with sf.SoundFile(args.input) as handle, torch.inference_mode():
        for start in range(-chunk + hop, frames, hop):
            signal = read_reflected(handle, start, chunk)
            batch = torch.from_numpy(signal.T.copy()).unsqueeze(1).to(device)
            spectrum = model.stft(batch)
            encoded = model.tf_model(model.band_split(spectrum))
            left, right = max(0, start), min(frames, start + chunk)
            a, b = left - start, right - start
            weight[left:right] += window[a:b]
            for name in STEMS:
                result = model.istft(spectrum * model.mask_estim[name](encoded), chunk).squeeze(1).cpu().numpy().T
                if not np.isfinite(result).all():
                    raise SystemExit("模型输出了非有限值")
                predicted[name][left:right] += result[a:b] * window[a:b, None]
    if np.any(weight <= 1e-8):
        raise SystemExit("重叠相加留下了没覆盖的采样")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name in STEMS:
        predicted[name] /= weight[:, None]
        sf.write(args.output_dir / f"{name}.wav", predicted[name], rate, subtype="FLOAT")
    sf.write(args.output_dir / "no_bgm.wav", audio - predicted["music"], rate, subtype="FLOAT")
    intervals = {
        "cellSeconds": CELL_SECONDS,
        "thresholdDb": ACTIVE_DB,
        "speech": active_intervals(predicted["speech"], rate),
        "sfx": active_intervals(predicted["sfx"], rate)
    }
    (args.output_dir / "intervals.json").write_text(json.dumps(intervals, ensure_ascii=False))
    print(json.dumps({"done": True, "device": device, "frames": frames}), flush=True)


if __name__ == "__main__":
    main()

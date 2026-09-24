#!/usr/bin/env python3
"""Transcribe the three local AI-video tutorials with timestamped output."""

from pathlib import Path
import argparse
from faster_whisper import WhisperModel


ROOT = Path("/Users/qinfen/Downloads/mimo-short-video-director-master")
INPUT = Path("/Users/qinfen/Documents/Ox-Workspace/input")
OUTPUT = ROOT / "transcripts"
VIDEOS = (
    (INPUT / "01-ai-image.mp4", "01-图片提示词"),
    (INPUT / "02-ai-video.mp4.mp4", "02-视频生成"),
    (INPUT / "03-seedance-reference.mp4", "03-全能参考视频提示词"),
)


def timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=int, choices=range(1, len(VIDEOS) + 1))
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        "small", device="cpu", compute_type="int8", cpu_threads=3, num_workers=1
    )
    selected_videos = VIDEOS if args.video is None else (VIDEOS[args.video - 1],)
    for video, output_name in selected_videos:
        print(f"TRANSCRIBING {video.name}", flush=True)
        segments, info = model.transcribe(
            str(video),
            language="zh",
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=True,
        )
        transcript_path = OUTPUT / f"{output_name}.txt"
        with transcript_path.open("w", encoding="utf-8") as transcript:
            transcript.write(f"# {output_name}\n")
            transcript.write(f"# language={info.language} probability={info.language_probability:.4f}\n\n")
            for segment in segments:
                text = segment.text.strip()
                if text:
                    transcript.write(
                        f"[{timestamp(segment.start)} --> {timestamp(segment.end)}] {text}\n"
                    )
        print(f"WROTE {transcript_path}", flush=True)


if __name__ == "__main__":
    main()

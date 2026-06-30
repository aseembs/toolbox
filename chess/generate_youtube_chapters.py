#!/usr/bin/env python3

"""
==============================================================================
Script Name:   generate_youtube_chapters.py
Description:   Scans a course directory for numbered section folders and video 
               files, calculates their lengths using 'ffprobe', and generates a 
               'youtube_chapters.txt' file with running timestamps. This format 
               is ideal for creating chapter markers when uploading a seamlessly 
               merged course video to YouTube.
Usage:         python3 generate_youtube_chapters.py [optional/path/to/course]
Dependencies:  - Standard Python 3 library (pathlib, re, subprocess, sys)
               - 'ffprobe' (Must be installed via FFmpeg and in system PATH)
==============================================================================
"""

import pathlib
import re
import subprocess
import sys

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}


def natural_sort_key(path: pathlib.Path):
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", path.name)
    ]


def parse_number_and_title(name: str):
    """
    Examples:
      '1 - Getting Started' -> (1, 'Getting Started')
      '10 - Advanced'       -> (10, 'Advanced')
      '01 - Welcome.mp4'    -> (1, 'Welcome')
      '2. Setup.mp4'        -> (2, 'Setup')
    """
    stem = pathlib.Path(name).stem

    match = re.match(r"^\s*(\d+)\s*[-_. )]+(.+?)\s*$", stem)

    if match:
        number = int(match.group(1))
        title = match.group(2)
    else:
        number = None
        title = stem

    title = title.replace("_", " ")
    title = re.sub(r"\s+", " ", title).strip()

    return number, title


def get_duration_seconds(video_path: pathlib.Path) -> float:
    result = subprocess.check_output(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        text=True,
    ).strip()

    return float(result)


def format_youtube_time(seconds: float) -> str:
    seconds = int(seconds)

    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60

    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"

    return f"{minutes:02d}:{secs:02d}"


def main():
    course_folder = (
        pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.cwd()
    )
    course_folder = course_folder.resolve()

    output_file = course_folder / "youtube_chapters.txt"

    section_folders = sorted(
        [p for p in course_folder.iterdir() if p.is_dir()],
        key=natural_sort_key,
    )

    if not section_folders:
        print("No section folders found.")
        sys.exit(1)

    total_seconds = 0.0
    chapter_lines = []

    for section_folder in section_folders:
        section_number, section_title = parse_number_and_title(section_folder.name)

        if section_number is None:
            print(f"Skipping folder without leading number: {section_folder.name}")
            continue

        section_label = f"S{section_number:02d} {section_title}"

        videos = sorted(
            [
                p
                for p in section_folder.iterdir()
                if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
            ],
            key=natural_sort_key,
        )

        for fallback_chapter_number, video in enumerate(videos, start=1):
            chapter_number, chapter_title = parse_number_and_title(video.name)

            if chapter_number is None:
                chapter_number = fallback_chapter_number

            timestamp = format_youtube_time(total_seconds)

            line = (
                f"{timestamp} "
                f"{section_label} - "
                f"{chapter_number:02d}. {chapter_title}"
            )

            chapter_lines.append(line)
            print(line)

            duration = get_duration_seconds(video)
            total_seconds += duration

    output_file.write_text("\n".join(chapter_lines) + "\n", encoding="utf-8")

    print()
    print(f"Created: {output_file}")
    print(f"Total duration: {format_youtube_time(total_seconds)}")


if __name__ == "__main__":
    main()

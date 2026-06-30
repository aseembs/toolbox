#!/usr/bin/env python3

import pathlib
import re
import sys

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}

DRY_RUN = False  # Change to False after checking the output.


def natural_sort_key(path):
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", path.name)
    ]


def parse_leading_number(text):
    """
    Extracts leading number from:
      '1 - Intro'
      '10 - Advanced'
      '02_Basics'
      '003. Setup'
    """
    match = re.match(r"^\s*(\d+)\s*[-_. )]+(.+?)\s*$", text)
    if match:
        return int(match.group(1)), match.group(2).strip()

    return None, text.strip()


def clean_title_from_filename(path):
    """
    Removes leading chapter number from filename:
      '1 - Welcome.mp4' -> 'Welcome'
      '02_Setup.mp4' -> 'Setup'
    """
    number, title = parse_leading_number(path.stem)
    title = title.replace("_", " ")
    title = re.sub(r"\s+", " ", title).strip()
    return number, title


def safe_filename(text):
    text = text.replace("/", "-").replace(":", " -")
    text = re.sub(r'[\\:*?"<>|]', "-", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def already_prefixed(filename):
    return (
        re.match(r"^S\d{2,}\s*-\s*C\d{3,}\s*-", filename, re.IGNORECASE) is not None
    )


def main():
    course_folder = (
        pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.cwd()
    )
    course_folder = course_folder.resolve()

    if not course_folder.exists():
        print(f"Folder does not exist: {course_folder}")
        sys.exit(1)

    section_folders = sorted(
        [p for p in course_folder.iterdir() if p.is_dir()],
        key=natural_sort_key,
    )

    if not section_folders:
        print("No section folders found.")
        sys.exit(1)

    planned_renames = []

    for section_folder in section_folders:
        section_number, section_title = parse_leading_number(section_folder.name)

        if section_number is None:
            print(f"Skipping section with no leading number: {section_folder.name}")
            continue

        videos = sorted(
            [
                f
                for f in section_folder.iterdir()
                if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS
            ],
            key=natural_sort_key,
        )

        for fallback_chapter_index, video in enumerate(videos, start=1):
            if already_prefixed(video.name):
                continue

            chapter_number, chapter_title = clean_title_from_filename(video)

            if chapter_number is None:
                chapter_number = fallback_chapter_index

            new_name = safe_filename(
                f"S{section_number:02d} - C{chapter_number:03d} - "
                f"{chapter_title}{video.suffix.lower()}"
            )

            destination = video.with_name(new_name)

            if destination.exists():
                print(f"Collision, skipping: {destination}")
                continue

            planned_renames.append((video, destination))

    if not planned_renames:
        print("No files to rename.")
        return

    print("Planned renames:\n")

    for old, new in planned_renames:
        print(f"{old.name}")
        print(f"  -> {new.name}")
        print()

    if DRY_RUN:
        print("DRY_RUN is True. No files were renamed.")
        print("After reviewing, edit the script and set:")
        print("DRY_RUN = False")
        return

    for old, new in planned_renames:
        old.rename(new)

    print(f"Renamed {len(planned_renames)} files.")


if __name__ == "__main__":
    main()
    
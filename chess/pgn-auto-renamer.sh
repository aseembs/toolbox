#!/bin/bash

# ==============================================================================
# Script Name:   PGN Auto-Renamer
# Description:   Monitors the current directory for newly created .pgn files and 
#                automatically renames them by adding a sequential prefix based 
#                on a user-provided seed number (e.g., 'seed.counter) filename.pgn'). 
#                It strips out existing numeric prefixes to keep filenames clean.
#                Uses 'inotifywait' for real-time event monitoring if available, 
#                otherwise falls back to a 10-second polling loop.
# Usage:         ./script_name.sh <seed_number>
# Example:       ./script_name.sh 3
# Dependencies:  inotify-tools (optional, for 'inotifywait')
# ==============================================================================


# Seed number input
seed=$1

# Validate seed input
if ! [[ "$seed" =~ ^[0-9]+$ ]]; then
  echo "Seed must be a positive integer."
  exit 1
fi

# Initialize counter
counter=0

echo "Monitoring current directory for new .pgn files with seed prefix $seed..."

# Function to rename files with prefix
rename_file () {
  local file="$1"

  # Skip files that already start with the expected prefix (e.g., 2.1) )
  if [[ "$file" =~ ^$seed\.[0-9]+\) ]]; then
    return
  fi

  ((counter++))
  new_prefix="$seed.$counter)"

  # Remove existing prefix like '4)' or '4.1)' at start
  new_name="${file}"
  if [[ "$file" =~ ^[0-9]+(\.[0-9]+)?\) ]]; then
    new_name="${file#*) }"  # Remove prefix and the following space
  fi

  # Rename file with new prefix
  mv -n "$file" "$new_prefix $new_name"
  echo "Renamed '$file' to '$new_prefix $new_name'"
}

# Use inotifywait if available, otherwise fallback to polling every 10 seconds
if command -v inotifywait &> /dev/null; then
  # inotifywait inherently detects only new files, so no extra handling needed
  while true; do
    files=$(inotifywait -e create --format "%f" . --quiet)
    for file in $files; do
      if [[ "$file" == *.pgn ]]; then
        rename_file "$file"
      fi
    done
  done
else
  echo "inotifywait not found, falling back to polling every 10 seconds..."
  # Initialize seen_files with existing .pgn files to avoid renaming them
  seen_files=()
  for f in *.pgn; do
    [[ -e "$f" ]] && seen_files+=("$f")
  done

  while true; do
    for file in *.pgn; do
      if [[ ! " ${seen_files[@]} " =~ " $file " ]]; then
        rename_file "$file"
        seen_files+=("$file")
      fi
    done
    sleep 10
  done
fi


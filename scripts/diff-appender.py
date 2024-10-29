#!/usr/bin/env python3
import sys
import re
from pathlib import Path
from typing import List, Tuple

def parse_unified_diff(diff_file: Path) -> List[Tuple[str, List[str]]]:
    """
    Parse a unified diff file and extract target files and their new lines.
    
    Args:
        diff_file: Path to the unified diff file
    
    Returns:
        List of tuples containing (target_file_path, list_of_new_lines)
    """
    results = []
    current_file = None
    new_lines = []
    
    # Regex patterns for diff analysis
    target_pattern = re.compile(r'^\+\+\+ b/(.+)$')
    addition_pattern = re.compile(r'^\+(.*)$')
    
    try:
        with open(diff_file, 'r') as f:
            for line in f:
                line = line.rstrip('\n')
                
                # Check for target file marker
                target_match = target_pattern.match(line)
                if target_match:
                    # If we were processing a previous file, save its results
                    if current_file and new_lines:
                        results.append((current_file, new_lines))
                    
                    current_file = target_match.group(1)
                    new_lines = []
                    continue
                
                # Check for added lines
                addition_match = addition_pattern.match(line)
                if addition_match and current_file:
                    # Don't include empty additions ('+' by itself)
                    content = addition_match.group(1)
                    new_lines.append(content)
        
        # Don't forget to add the last file's results
        if current_file and new_lines:
            results.append((current_file, new_lines))
            
    except FileNotFoundError:
        print(f"Error: Could not find diff file: {diff_file}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error reading diff file: {str(e)}", file=sys.stderr)
        sys.exit(1)
        
    return results

def append_new_lines(target_file: Path, new_lines: List[str]) -> None:
    """
    Append new lines to the target file.
    
    Args:
        target_file: Path to the target file
        new_lines: List of lines to append
    """
    try:
        # Create parent directories if they don't exist
        target_file.parent.mkdir(parents=True, exist_ok=True)
        
        # Ensure file exists
        if not target_file.exists():
            target_file.touch()
        
        # Check if file ends with newline
        ends_with_newline = True
        if target_file.stat().st_size > 0:
            with open(target_file, 'rb') as f:
                f.seek(-1, 2)  # Seek to last character
                ends_with_newline = f.read(1) == b'\n'
        
        # Append new lines
        with open(target_file, 'a') as f:
            # Add newline if file doesn't end with one
            if not ends_with_newline and target_file.stat().st_size > 0:
                f.write('\n')
            
            # Write new lines
            for line in new_lines:
                f.write(line + '\n')
                
    except Exception as e:
        print(f"Error appending to {target_file}: {str(e)}", file=sys.stderr)
        sys.exit(1)

def main():
    if len(sys.argv) != 2:
        print("Usage: python diff_appender.py <diff_file>", file=sys.stderr)
        sys.exit(1)
    
    diff_file = Path(sys.argv[1])
    
    # Parse the diff file
    file_changes = parse_unified_diff(diff_file)
    
    if not file_changes:
        print("No new lines found to append.", file=sys.stderr)
        sys.exit(0)
    
    # Process each file
    for target_file_path, new_lines in file_changes:
        if new_lines:  # Only process if there are actually new lines
            target_file = Path(target_file_path)
            print(f"Appending {len(new_lines)} new lines to {target_file}")
            append_new_lines(target_file, new_lines)
    
    print("Done!")

if __name__ == "__main__":
    main()

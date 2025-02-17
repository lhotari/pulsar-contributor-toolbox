#!/usr/bin/env python3
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from typing import List, Dict, Optional
from argparse import ArgumentParser

@dataclass
class DeadlockInfo:
    threads: List[str]
    description: str
    waiting_threads: Dict[str, Dict[str, str]]  # thread name -> {waiting_for, holding}

@dataclass
class ThreadInfo:
    name: str
    tid: str = ""
    nid: str = ""
    state: str = ""
    cpu_time: str = ""
    elapsed_time: str = ""
    stack_trace: List[str] = None
    waiting_on: str = ""
    locked_sync: List[str] = None
    locked_ownable: List[str] = None

    def __post_init__(self):
        if self.stack_trace is None:
            self.stack_trace = []
        if self.locked_sync is None:
            self.locked_sync = []
        if self.locked_ownable is None:
            self.locked_ownable = []

class ThreadDumpAnalyzer:
    THREAD_START_PATTERN = re.compile(r'^"([^"]+)"\s+#\d+.*tid=(0x[0-9a-f]+)\s+nid=(0x[0-9a-f]+)\s+.*\[(0x[0-9a-f]+)\]?.*')
    THREAD_STATE_PATTERN = re.compile(r'^\s+java.lang.Thread.State: ([A-Z_]+)(?:\s+\((.*)\))?')
    STACK_TRACE_PATTERN = re.compile(r'^\s+at (.+)')
    LOCKED_SYNC_PATTERN = re.compile(r'^\s+- locked <(0x[0-9a-f]+)> \(a ([^)]+)\)')
    LOCKED_OWNABLE_PATTERN = re.compile(r'^\s+- locked <(0x[0-9a-f]+)> \(([^)]+)\)')
    WAITING_ON_PATTERN = re.compile(r'^\s+- waiting to lock <(0x[0-9a-f]+)> \(([^)]+)\)')
    DEADLOCK_START_PATTERN = re.compile(r'^Found (\d+) Java-level deadlock')
    CPU_TIME_PATTERN = re.compile(r'cpu=([\d.]+)ms\s+elapsed=([\d.]+)s')

    def __init__(self, filename: str):
        self.filename = filename
        self.threads: List[ThreadInfo] = []
        self.deadlocks: List[DeadlockInfo] = []

    def parse_thread_dump(self) -> None:
        current_thread = None
        in_deadlock_section = False
        deadlock_buffer = []
        current_deadlock = None
        in_stack_info = False
        
        try:
            with open(self.filename, 'r') as f:
                for line in f:
                    line = line.rstrip()
                    
                    # Check for deadlock section
                    if "Found" in line and "Java-level deadlock" in line:
                        in_deadlock_section = True
                        deadlock_buffer = [line]
                        current_deadlock = DeadlockInfo(
                            threads=[],
                            description="",
                            waiting_threads={}
                        )
                        continue

                    if in_deadlock_section:
                        if line.strip():
                            deadlock_buffer.append(line)
                            # Capture thread names in deadlock
                            if line.startswith('"'):
                                thread_name = line.split('"')[1]
                                if thread_name not in current_deadlock.threads:
                                    current_deadlock.threads.append(thread_name)
                            # Parse waiting relationships
                            waiting_match = self.WAITING_ON_PATTERN.match(line)
                            if waiting_match and current_deadlock.threads:
                                thread_name = current_deadlock.threads[-1]
                                if thread_name not in current_deadlock.waiting_threads:
                                    current_deadlock.waiting_threads[thread_name] = {}
                                current_deadlock.waiting_threads[thread_name]['waiting_for'] = waiting_match.group(1)
                        elif deadlock_buffer:  # Empty line marks end of section
                            current_deadlock.description = "\n".join(deadlock_buffer)
                            self.deadlocks.append(current_deadlock)
                            in_deadlock_section = False
                            in_stack_info = False
                            deadlock_buffer = []
                        continue
                    
                    # Parse thread information
                    thread_match = self.THREAD_START_PATTERN.match(line)
                    if thread_match:
                        current_thread = ThreadInfo(
                            name=thread_match.group(1),
                            tid=thread_match.group(2),
                            nid=thread_match.group(3)
                        )
                        # Extract CPU time if present
                        cpu_match = self.CPU_TIME_PATTERN.search(line)
                        if cpu_match:
                            current_thread.cpu_time = cpu_match.group(1)
                            current_thread.elapsed_time = cpu_match.group(2)
                        self.threads.append(current_thread)
                        continue

                    if current_thread:
                        state_match = self.THREAD_STATE_PATTERN.match(line)
                        if state_match:
                            current_thread.state = state_match.group(1)
                            continue

                        stack_match = self.STACK_TRACE_PATTERN.match(line)
                        if stack_match:
                            current_thread.stack_trace.append(stack_match.group(1))
                            continue

                        locked_sync_match = self.LOCKED_SYNC_PATTERN.match(line)
                        if locked_sync_match:
                            current_thread.locked_sync.append(
                                f"{locked_sync_match.group(1)} ({locked_sync_match.group(2)})"
                            )
                            if self.deadlocks and current_thread.name in self.deadlocks[-1].waiting_threads:
                                self.deadlocks[-1].waiting_threads[current_thread.name]['holding'] = locked_sync_match.group(1)
                            continue

                        waiting_match = self.WAITING_ON_PATTERN.match(line)
                        if waiting_match:
                            current_thread.waiting_on = f"{waiting_match.group(1)} ({waiting_match.group(2)})"
                            continue

        except FileNotFoundError:
            print(f"Error: Could not find file {self.filename}")
            sys.exit(1)
        except Exception as e:
            print(f"Error reading thread dump file: {str(e)}")
            sys.exit(1)

    def analyze(self, runnable_only: bool = False, full_stack: bool = False) -> None:
        """Analyze the thread dump and print results."""
        if not self.threads:
            print("No threads found in the dump file.")
            return

        self._print_thread_state_summary()
        
        if runnable_only:
            self._print_runnable_threads(full_stack)
        else:
            self._print_deadlock_analysis(full_stack)
            self._print_cpu_analysis(full_stack)
            self._print_blocked_threads(full_stack)
            self._print_waiting_threads(full_stack)

    def _print_thread_state_summary(self) -> None:
        """Print summary of thread states."""
        state_count: Dict[str, int] = defaultdict(int)
        for thread in self.threads:
            state_count[thread.state] += 1

        print("\n=== Thread State Summary ===")
        for state, count in sorted(state_count.items()):
            if state:  # Only print if state is not empty
                print(f"{state}: {count} thread(s)")
        print(f"Total Threads: {len(self.threads)}")

    def _print_deadlock_analysis(self, full_stack: bool = False) -> None:
        """Print information about deadlocks found by jstack -l."""
        if self.deadlocks:
            print("\n=== Deadlock Analysis ===")
            for i, deadlock in enumerate(self.deadlocks, 1):
                print(f"\nDeadlock #{i}:")
                print("Threads involved:")
                for thread in deadlock.waiting_threads:
                    waiting_info = deadlock.waiting_threads[thread]
                    print(f"  {thread}:")
                    if 'waiting_for' in waiting_info:
                        print(f"    - Waiting for lock: <{waiting_info['waiting_for']}>")
                    if 'holding' in waiting_info:
                        print(f"    - Holding lock: <{waiting_info['holding']}>")
                    # Find matching thread to print its stack trace
                    for t in self.threads:
                        if t.name == thread:
                            frames = t.stack_trace if full_stack else t.stack_trace[:3]
                            if frames:
                                print("    Stack trace:")
                                for frame in frames:
                                    print(f"      {frame}")
                                if not full_stack and len(t.stack_trace) > 3:
                                    print(f"      ... ({len(t.stack_trace) - 3} more lines)")
                                break
                print("\nFull deadlock description:")
                print(deadlock.description)
                print("----------------------------------------")

    def _print_runnable_threads(self, full_stack: bool = False) -> None:
        """Print information about RUNNABLE threads."""
        runnable_threads = [t for t in self.threads if t.state == 'RUNNABLE']
        
        if runnable_threads:
            # Sort threads by stack trace length in descending order
            runnable_threads.sort(key=lambda t: len(t.stack_trace), reverse=True)
            
            print("\n=== RUNNABLE Threads ===")
            for thread in runnable_threads:
                self._print_thread_details(thread, full_stack)
                print("----------------------------------------")

    def _print_cpu_analysis(self, full_stack: bool = False) -> None:
        """Print analysis of CPU usage."""
        cpu_threads = sorted(
            [t for t in self.threads if t.cpu_time],
            key=lambda x: float(x.cpu_time),
            reverse=True
        )[:10]  # Top 10 CPU consumers

        if cpu_threads:
            print("\n=== Top 10 CPU Consuming Threads ===")
            for thread in cpu_threads:
                print(f"\nThread: {thread.name}")
                print(f"CPU Time: {thread.cpu_time}ms")
                print(f"State: {thread.state}")
                if thread.stack_trace:
                    print("Stack trace:")
                    frames = thread.stack_trace if full_stack else thread.stack_trace[:3]
                    for frame in frames:
                        print(f"  {frame}")
                    if not full_stack and len(thread.stack_trace) > 3:
                        print(f"  ... ({len(thread.stack_trace) - 3} more lines)")

    def _print_waiting_threads(self, full_stack: bool = False) -> None:
        """Print information about WAITING/TIMED_WAITING threads."""
        waiting_threads = [t for t in self.threads if t.state in ('WAITING', 'TIMED_WAITING')]
        
        if waiting_threads:
            print("\n=== Waiting Threads ===")
            for thread in waiting_threads:
                self._print_thread_details(thread, full_stack)
                print("----------------------------------------")

    def _print_blocked_threads(self, full_stack: bool = False) -> None:
        """Print information about BLOCKED threads."""
        blocked_threads = [t for t in self.threads if t.state == 'BLOCKED']
        
        if blocked_threads:
            print("\n=== Blocked Threads ===")
            for thread in blocked_threads:
                self._print_thread_details(thread, full_stack)
                print("----------------------------------------")

    def _print_thread_details(self, thread: ThreadInfo, full_stack: bool = False) -> None:
        """Print detailed information about a specific thread."""
        print(f"\nThread: {thread.name}")
        print(f"State: {thread.state}")
        if thread.cpu_time:
            print(f"CPU Time: {thread.cpu_time}ms")
        if thread.waiting_on:
            print(f"Waiting on: {thread.waiting_on}")
        if thread.locked_sync:
            print("Locked synchronizers:")
            for lock in thread.locked_sync:
                print(f"  {lock}")
        if thread.locked_ownable:
            print("Locked ownables:")
            for lock in thread.locked_ownable:
                print(f"  {lock}")
        if thread.stack_trace:
            print("Stack trace:")
            frames = thread.stack_trace if full_stack else thread.stack_trace[:3]
            for frame in frames:
                print(f"  {frame}")
            if not full_stack and len(thread.stack_trace) > 3:
                print(f"  ... ({len(thread.stack_trace) - 3} more lines)")

def main():
    parser = ArgumentParser(description="Analyze Java thread dumps")
    parser.add_argument("filename", help="Path to the thread dump file")
    parser.add_argument("--verbose", "-v", action="store_true", 
                       help="Show detailed information for all threads")
    parser.add_argument("--runnable", "-r", action="store_true",
                       help="Show only RUNNABLE threads")
    parser.add_argument("--full-stack", "-f", action="store_true",
                       help="Show full stack traces instead of truncated ones")
    args = parser.parse_args()

    analyzer = ThreadDumpAnalyzer(args.filename)
    analyzer.parse_thread_dump()
    analyzer.analyze(runnable_only=args.runnable, full_stack=args.full_stack)

if __name__ == "__main__":
    main()
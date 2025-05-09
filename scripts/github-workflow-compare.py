#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.6"
# dependencies = [
#     "matplotlib",
#     "requests",
#     "tabulate",
# ]
# ///
"""
GitHub Workflow Run Time Comparison

This script compares the running times of build jobs between two GitHub Actions workflow runs.
It requires a GitHub Personal Access Token with appropriate permissions.

Usage:
    python github_workflow_compare.py --owner OWNER --repo REPO --workflow WORKFLOW_ID --run1 RUN_ID1 --run2 RUN_ID2 [--token TOKEN]

Arguments:
    --owner      GitHub repository owner (username or organization)
    --repo       GitHub repository name
    --workflow   Workflow ID or filename
    --run1       First workflow run ID to compare
    --run2       Second workflow run ID to compare
    --token      GitHub Personal Access Token (optional, can be set as GITHUB_TOKEN environment variable)
"""

import os
import sys
import argparse
import requests
from datetime import datetime
import json
from typing import Dict, List, Any, Tuple
from tabulate import tabulate
import matplotlib.pyplot as plt
from pathlib import Path


class GitHubWorkflowComparer:
    """Class to compare GitHub workflow runs"""
    
    BASE_URL = "https://api.github.com"
    
    def __init__(self, owner: str, repo: str, token: str = None):
        """Initialize with repository information and optional token"""
        self.owner = owner
        self.repo = repo
        self.token = token or os.environ.get("GITHUB_TOKEN")
        
        if not self.token:
            raise ValueError("GitHub token must be provided via --token argument or GITHUB_TOKEN environment variable")
            
        self.headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "X-GitHub-Api-Version": "2022-11-28"
        }
    
    def get_workflow_run(self, run_id: int) -> Dict[str, Any]:
        """Get workflow run details"""
        url = f"{self.BASE_URL}/repos/{self.owner}/{self.repo}/actions/runs/{run_id}"
        response = requests.get(url, headers=self.headers)
        response.raise_for_status()
        return response.json()
    
    def get_run_jobs(self, run_id: int) -> List[Dict[str, Any]]:
        """Get all jobs for a specific workflow run"""
        url = f"{self.BASE_URL}/repos/{self.owner}/{self.repo}/actions/runs/{run_id}/jobs"
        
        all_jobs = []
        page = 1
        per_page = 100
        
        while True:
            response = requests.get(
                url, 
                headers=self.headers,
                params={"page": page, "per_page": per_page}
            )
            response.raise_for_status()
            data = response.json()
            jobs = data.get("jobs", [])
            
            if not jobs:
                break
                
            all_jobs.extend(jobs)
            
            if len(jobs) < per_page:
                break
                
            page += 1
            
        return all_jobs
    
    def parse_job_duration(self, job: Dict[str, Any]) -> float:
        """Calculate job duration in seconds"""
        if job["status"] != "completed":
            return 0
            
        start_time = datetime.fromisoformat(job["started_at"].replace("Z", "+00:00"))
        end_time = datetime.fromisoformat(job["completed_at"].replace("Z", "+00:00"))
        
        return (end_time - start_time).total_seconds()
    
    def format_duration(self, seconds: float) -> str:
        """Format seconds into readable duration string"""
        minutes, seconds = divmod(int(seconds), 60)
        hours, minutes = divmod(minutes, 60)
        
        if hours > 0:
            return f"{hours}h {minutes}m {seconds}s"
        elif minutes > 0:
            return f"{minutes}m {seconds}s"
        else:
            return f"{seconds}s"
    
    def compare_runs(self, run_id1: int, run_id2: int) -> Dict[str, Any]:
        """Compare two workflow runs and their jobs"""
        # Get run details
        run1 = self.get_workflow_run(run_id1)
        run2 = self.get_workflow_run(run_id2)
        
        # Get jobs for each run
        jobs1 = self.get_run_jobs(run_id1)
        jobs2 = self.get_run_jobs(run_id2)
        
        # Process job data
        run1_data = {
            "run_id": run_id1,
            "name": run1["name"],
            "branch": run1["head_branch"],
            "commit": run1["head_sha"][:7],
            "created_at": run1["created_at"],
            "status": run1["status"],
            "conclusion": run1["conclusion"],
            "url": run1["html_url"],
            "total_duration": 0,
            "jobs": {}
        }
        
        run2_data = {
            "run_id": run_id2,
            "name": run2["name"],
            "branch": run2["head_branch"],
            "commit": run2["head_sha"][:7],
            "created_at": run2["created_at"],
            "status": run2["status"],
            "conclusion": run2["conclusion"],
            "url": run2["html_url"],
            "total_duration": 0,
            "jobs": {}
        }
        
        # Process jobs for run 1
        for job in jobs1:
            duration = self.parse_job_duration(job)
            run1_data["jobs"][job["name"]] = {
                "id": job["id"],
                "name": job["name"],
                "status": job["status"],
                "conclusion": job["conclusion"],
                "duration": duration,
                "duration_formatted": self.format_duration(duration),
                "url": job["html_url"]
            }
            if job["status"] == "completed" and job["conclusion"] == "success":
                run1_data["total_duration"] += duration
        
        # Process jobs for run 2
        for job in jobs2:
            duration = self.parse_job_duration(job)
            run2_data["jobs"][job["name"]] = {
                "id": job["id"],
                "name": job["name"],
                "status": job["status"],
                "conclusion": job["conclusion"],
                "duration": duration,
                "duration_formatted": self.format_duration(duration),
                "url": job["html_url"]
            }
            if job["status"] == "completed" and job["conclusion"] == "success":
                run2_data["total_duration"] += duration
        
        # Prepare comparison data
        comparison = {
            "run1": run1_data,
            "run2": run2_data,
            "job_comparisons": [],
            "summary": {
                "run1_total_duration": self.format_duration(run1_data["total_duration"]),
                "run2_total_duration": self.format_duration(run2_data["total_duration"]),
                "difference": self.format_duration(abs(run1_data["total_duration"] - run2_data["total_duration"])),
                "percent_change": round(
                    ((run2_data["total_duration"] - run1_data["total_duration"]) / run1_data["total_duration"]) * 100
                    if run1_data["total_duration"] > 0 else 0,
                    2
                )
            }
        }
        
        # Compare matching jobs
        all_job_names = set(run1_data["jobs"].keys()) | set(run2_data["jobs"].keys())
        
        for job_name in all_job_names:
            job1 = run1_data["jobs"].get(job_name)
            job2 = run2_data["jobs"].get(job_name)
            
            if job1 and job2:
                duration_diff = job2["duration"] - job1["duration"]
                percent_change = (
                    (duration_diff / job1["duration"]) * 100
                    if job1["duration"] > 0 else 0
                )
                
                comparison["job_comparisons"].append({
                    "job_name": job_name,
                    "run1_duration": job1["duration"],
                    "run1_duration_formatted": job1["duration_formatted"],
                    "run2_duration": job2["duration"],
                    "run2_duration_formatted": job2["duration_formatted"],
                    "difference": self.format_duration(abs(duration_diff)),
                    "difference_seconds": abs(duration_diff),
                    "percent_change": round(percent_change, 2),
                    "faster_in": "run1" if duration_diff > 0 else "run2" if duration_diff < 0 else "same"
                })
            elif job1:
                comparison["job_comparisons"].append({
                    "job_name": job_name,
                    "run1_duration": job1["duration"],
                    "run1_duration_formatted": job1["duration_formatted"],
                    "run2_duration": 0,
                    "run2_duration_formatted": "N/A",
                    "difference": job1["duration_formatted"],
                    "difference_seconds": job1["duration"],
                    "percent_change": -100,
                    "faster_in": "missing_in_run2"
                })
            elif job2:
                comparison["job_comparisons"].append({
                    "job_name": job_name,
                    "run1_duration": 0,
                    "run1_duration_formatted": "N/A",
                    "run2_duration": job2["duration"],
                    "run2_duration_formatted": job2["duration_formatted"],
                    "difference": job2["duration_formatted"],
                    "difference_seconds": job2["duration"],
                    "percent_change": float('inf'),
                    "faster_in": "missing_in_run1"
                })
        
        # Sort job comparisons by absolute difference (biggest first)
        comparison["job_comparisons"].sort(key=lambda x: x["difference_seconds"], reverse=True)
        
        return comparison
    
    def generate_charts(self, comparison: Dict[str, Any], output_dir: str = ".") -> List[str]:
        """Generate comparison charts and save to files"""
        output_path = Path(output_dir)
        output_path.mkdir(exist_ok=True)
        
        chart_files = []
        
        # Only include jobs that exist in both runs
        jobs_in_both = [j for j in comparison["job_comparisons"] 
                       if j["faster_in"] not in ("missing_in_run1", "missing_in_run2")]
        
        if not jobs_in_both:
            return chart_files
            
        # 1. Bar chart of job durations
        plt.figure(figsize=(12, max(6, len(jobs_in_both) * 0.4)))
        
        job_names = [job["job_name"] for job in jobs_in_both]
        run1_durations = [job["run1_duration"] for job in jobs_in_both]
        run2_durations = [job["run2_duration"] for job in jobs_in_both]
        
        y_pos = range(len(job_names))
        
        plt.barh(y_pos, run1_durations, height=0.4, align='center', alpha=0.8, label=f'Run {comparison["run1"]["run_id"]}')
        plt.barh([p + 0.4 for p in y_pos], run2_durations, height=0.4, align='center', alpha=0.8, label=f'Run {comparison["run2"]["run_id"]}')
        
        plt.yticks([p + 0.2 for p in y_pos], job_names)
        plt.xlabel('Duration (seconds)')
        plt.title('Job Duration Comparison')
        plt.legend()
        plt.tight_layout()
        
        bar_chart_file = output_path / f'job_duration_comparison_{comparison["run1"]["run_id"]}_{comparison["run2"]["run_id"]}.png'
        plt.savefig(bar_chart_file)
        plt.close()
        chart_files.append(str(bar_chart_file))
        
        # 2. Pie chart of total duration breakdown for each run
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 8))
        
        # Run 1
        job_names = []
        durations = []
        for job in jobs_in_both:
            if job["run1_duration"] > 0:
                job_names.append(job["job_name"])
                durations.append(job["run1_duration"])
        
        if durations:
            ax1.pie(durations, autopct='%1.1f%%', startangle=90)
            ax1.axis('equal')
            ax1.set_title(f'Run {comparison["run1"]["run_id"]} Duration Distribution')
            ax1.legend(job_names, loc="center left", bbox_to_anchor=(1, 0, 0.5, 1))
        
        # Run 2
        job_names = []
        durations = []
        for job in jobs_in_both:
            if job["run2_duration"] > 0:
                job_names.append(job["job_name"])
                durations.append(job["run2_duration"])
        
        if durations:
            ax2.pie(durations, autopct='%1.1f%%', startangle=90)
            ax2.axis('equal')
            ax2.set_title(f'Run {comparison["run2"]["run_id"]} Duration Distribution')
            ax2.legend(job_names, loc="center left", bbox_to_anchor=(1, 0, 0.5, 1))
        
        plt.tight_layout()
        pie_chart_file = output_path / f'duration_distribution_{comparison["run1"]["run_id"]}_{comparison["run2"]["run_id"]}.png'
        plt.savefig(pie_chart_file)
        plt.close()
        chart_files.append(str(pie_chart_file))
        
        # 3. Percent change chart
        plt.figure(figsize=(12, max(6, len(jobs_in_both) * 0.4)))
        
        job_names = [job["job_name"] for job in jobs_in_both]
        pct_changes = [job["percent_change"] for job in jobs_in_both]
        
        colors = ['green' if pct < 0 else 'red' for pct in pct_changes]
        
        plt.barh(job_names, pct_changes, color=colors)
        plt.axvline(x=0, color='gray', linestyle='-', linewidth=0.5)
        plt.xlabel('Percent Change (%)')
        plt.title(f'Job Duration Change: Run {comparison["run1"]["run_id"]} → Run {comparison["run2"]["run_id"]}')
        plt.grid(axis='x', linestyle='--', alpha=0.7)
        plt.tight_layout()
        
        pct_chart_file = output_path / f'percent_change_{comparison["run1"]["run_id"]}_{comparison["run2"]["run_id"]}.png'
        plt.savefig(pct_chart_file)
        plt.close()
        chart_files.append(str(pct_chart_file))
        
        return chart_files
    
    def print_comparison_report(self, comparison: Dict[str, Any]) -> None:
        """Print a formatted report of the comparison results"""
        run1 = comparison["run1"]
        run2 = comparison["run2"]
        
        print("\n" + "="*80)
        print(f"GitHub Workflow Run Comparison: {run1['run_id']} vs {run2['run_id']}")
        print("="*80)
        
        print(f"\nRun {run1['run_id']}:")
        print(f"  Workflow: {run1['name']}")
        print(f"  Branch: {run1['branch']}")
        print(f"  Commit: {run1['commit']}")
        print(f"  Status: {run1['status']} / {run1['conclusion']}")
        print(f"  URL: {run1['url']}")
        
        print(f"\nRun {run2['run_id']}:")
        print(f"  Workflow: {run2['name']}")
        print(f"  Branch: {run2['branch']}")
        print(f"  Commit: {run2['commit']}")
        print(f"  Status: {run2['status']} / {run2['conclusion']}")
        print(f"  URL: {run2['url']}")
        
        print("\nSummary:")
        print(f"  Run {run1['run_id']} total duration: {comparison['summary']['run1_total_duration']}")
        print(f"  Run {run2['run_id']} total duration: {comparison['summary']['run2_total_duration']}")
        print(f"  Difference: {comparison['summary']['difference']}")
        
        if comparison['summary']['percent_change'] > 0:
            print(f"  Run {run2['run_id']} was {comparison['summary']['percent_change']}% slower than run {run1['run_id']}")
        elif comparison['summary']['percent_change'] < 0:
            print(f"  Run {run2['run_id']} was {abs(comparison['summary']['percent_change'])}% faster than run {run1['run_id']}")
        else:
            print(f"  Both runs took approximately the same time")
        
        print("\nJob Comparisons (sorted by biggest difference):")
        
        # Prepare table data
        table_data = []
        headers = ["Job Name", f"Run {run1['run_id']}", f"Run {run2['run_id']}", "Diff", "Change", "Faster In"]
        
        for job in comparison["job_comparisons"]:
            faster_in = ""
            if job["faster_in"] == "run1":
                faster_in = f"Run {run1['run_id']}"
            elif job["faster_in"] == "run2":
                faster_in = f"Run {run2['run_id']}"
            elif job["faster_in"] == "missing_in_run1":
                faster_in = f"N/A (new in Run {run2['run_id']})"
            elif job["faster_in"] == "missing_in_run2":
                faster_in = f"N/A (removed in Run {run2['run_id']})"
            else:
                faster_in = "Same"
                
            sign = "+" if job["percent_change"] > 0 else ""
            if job["faster_in"] in ("missing_in_run1", "missing_in_run2"):
                change = "N/A"
            else:
                change = f"{sign}{job['percent_change']}%"
                
            table_data.append([
                job["job_name"],
                job["run1_duration_formatted"],
                job["run2_duration_formatted"],
                job["difference"],
                change,
                faster_in
            ])
        
        print(tabulate(table_data, headers=headers, tablefmt="grid"))
        
        # Missing jobs in either run
        missing_in_run1 = [j for j in comparison["job_comparisons"] if j["faster_in"] == "missing_in_run1"]
        missing_in_run2 = [j for j in comparison["job_comparisons"] if j["faster_in"] == "missing_in_run2"]
        
        if missing_in_run1:
            print(f"\nJobs only in Run {run2['run_id']} (not in Run {run1['run_id']}):")
            for job in missing_in_run1:
                print(f"  - {job['job_name']}: {job['run2_duration_formatted']}")
        
        if missing_in_run2:
            print(f"\nJobs only in Run {run1['run_id']} (not in Run {run2['run_id']}):")
            for job in missing_in_run2:
                print(f"  - {job['job_name']}: {job['run1_duration_formatted']}")
    
    def save_json_report(self, comparison: Dict[str, Any], output_file: str) -> None:
        """Save the comparison data as a JSON file"""
        with open(output_file, 'w') as f:
            json.dump(comparison, f, indent=2)
        print(f"\nDetailed report saved to {output_file}")


def main():
    parser = argparse.ArgumentParser(description="Compare GitHub Actions workflow run times")
    
    parser.add_argument("--owner", required=True, help="GitHub repository owner")
    parser.add_argument("--repo", required=True, help="GitHub repository name")
    parser.add_argument("--workflow", required=False, help="Workflow ID or name (optional)")
    parser.add_argument("--run1", required=True, type=int, help="First workflow run ID to compare")
    parser.add_argument("--run2", required=True, type=int, help="Second workflow run ID to compare")
    parser.add_argument("--token", help="GitHub Personal Access Token (can also use GITHUB_TOKEN env var)")
    parser.add_argument("--output-dir", default=".", help="Directory to save charts and reports")
    parser.add_argument("--json", help="Save detailed report to the specified JSON file")
    parser.add_argument("--no-charts", action="store_true", help="Skip generating charts")
    
    args = parser.parse_args()
    
    try:
        comparer = GitHubWorkflowComparer(args.owner, args.repo, args.token)
        comparison = comparer.compare_runs(args.run1, args.run2)
        
        comparer.print_comparison_report(comparison)
        
        if not args.no_charts:
            chart_files = comparer.generate_charts(comparison, args.output_dir)
            if chart_files:
                print(f"\nCharts generated:")
                for chart_file in chart_files:
                    print(f"  - {chart_file}")
        
        if args.json:
            comparer.save_json_report(comparison, args.json)
            
    except Exception as e:
        print(f"Error: {str(e)}", file=sys.stderr)
        return 1
        
    return 0


if __name__ == "__main__":
    sys.exit(main())

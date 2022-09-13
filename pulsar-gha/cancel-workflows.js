const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });


const owner = "apache"
const repo = "pulsar"

function cancelIfInStatus(run, statuses) {
    if (statuses.includes(run.status)) {
        octokit.rest.actions.cancelWorkflowRun({
            owner,
            repo,
            run_id: run.id,
          });
        console.log("cancelled run for", run.id, run.html_url)
    }
    
}

async function downloadRuns(status) {
    let runs
    let page = 0
    const maxPage = 5
    let all = []
    console.log("searching", status)
    do {
        const data = await octokit.rest.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            per_page: 100,
            status: status,
            page:page++
        });
        
        console.log("download page #", page)
        runs = data.data.workflow_runs
        
        for (let r of runs) {
            if (r.head_commit.message.includes("[branch-2")) {
                cancelIfInStatus(r, [status])
            }
        }
        if (page === maxPage) {
            break
        }
    } while (runs.length !== 0)
    return all
}

function doIt() {
    downloadRuns("queued")
    downloadRuns("in_progress")
}

function schedule() {
    setTimeout(function () {
        doIt()
        console.log("Done.")
        schedule()
    }, 60 * 1000);
}

doIt()
console.log("Done.")
schedule()





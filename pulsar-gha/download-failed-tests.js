const { Octokit } = require("@octokit/rest");
const axios = require('axios');
const fs = require('fs');
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });


const owner = "apache"
const repo = "pulsar"

async function addTestForRun(r, tests) {

    return new Promise((resolve, reject) => {
        axios.get(r.check_suite_url + "/check-runs", {
            headers: {
                "Authorization": "Bearer " + process.env.GITHUB_TOKEN
            }
        }).then(checkRuns => {
            const annPromises = []
            for (let checkRun of checkRuns.data.check_runs) {
                if (checkRun.output && checkRun.output.annotations_count) {
                    annPromises.push(axios.get(checkRun.output.annotations_url, {
                        headers: {
                            "Authorization": "Bearer " + process.env.GITHUB_TOKEN
                        }
                    }).then(annotations => {
                        // console.log("found annotations", annotations.data.length)
                        for (let ann of annotations.data) {
                            if (ann.title) {
                                if (!tests[ann.title]) {
                                    tests[ann.title] = 0
                                }
                                tests[ann.title]++
                            } else {
                                // console.log("annotation with no title")
                            }
                        }
                    }).catch(e => console.error(e)));
                }
            }
            return Promise.all(annPromises)
        })
            .then(_ => resolve())
            .catch(e => console.error(e))
    });
}

function syncToFile(tests) {
    let sortable = []
    for (let k in tests) {
        if (tests[k] > 0)
            sortable.push({ test: k, count: tests[k] })
    }
    sortable.sort((a, b) => b.count - a.count)
    fs.writeFileSync("tests.json", JSON.stringify(sortable, null, 2))
}
async function downloadMoreTests(tests, currentPage) {
    syncToFile(tests)
    const maxPage = 100
    const data = await octokit.rest.actions.listWorkflowRuns({
            owner,
            repo,
            workflow_id: "pulsar-ci.yaml",
            per_page: 15,
            status: "failure",
            page: currentPage++
        });
        // -> check_suite_url -> check_suite_url + "/check-runs" -> {check_runs: [{output: {annotations_count: 0, annotations_url: <url>}}]} -> [{title}]

    console.log("download page #", currentPage)
    const runs = data.data.workflow_runs
    const promises = []

    for (let r of runs) {
        promises.push(addTestForRun(r, tests).catch(e => console.error(e)))
    }
    await Promise.all(promises)
    if (currentPage == maxPage) {
        return Promise.resolve()
    }
    return setTimeout(() => downloadMoreTests(tests, currentPage), 2000)
    
}
async function downloadTests() {
    tests = {}
    try {
        await downloadMoreTests(tests, 0)
        syncToFile(tests)
    } catch (err) {
        console.error(err)
    }
    return tests
}
downloadTests()


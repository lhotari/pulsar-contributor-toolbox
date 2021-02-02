# pulsar-contributor-toolbox

A toolbox for a Pulsar Contributor.

## Installation

Clone this repository to some parent directory, for example in `$HOME/workspace-pulsar`.

Include the functions in your ~/.zshrc or ~/.bashrc file:
```
export PULSAR_CONTRIBUTOR_TOOLBOX=$HOME/workspace-pulsar/pulsar-contributor-toolbox
. $PULSAR_CONTRIBUTOR_TOOLBOX/functions/pulsar-contributor-toolbox-functions.sh
PULSAR_DEV_DIR=$HOME/workspace-pulsar/pulsar
```

## Shell script functions

All shell script functions are in the [functions/pulsar-contributor-toolbox-functions.sh](functions/pulsar-contributor-toolbox-functions.sh) file.

Some highlights:

### ptbx_until_test_fails

Runs a `mvn test` command until it fails.

Example of running `TopicReaderTest`
```
ptbx_until_test_fails -Pcore-modules -pl pulsar-broker -Dtest=TopicReaderTest
```

### ptbx_until_test_fails_with_logs

Similar as `ptbx_until_test_fails`, but logs the output to a file.

Example of running `TopicReaderTest`
```
ptbx_until_test_fails_with_logs -Pcore-modules -pl pulsar-broker -Dtest=TopicReaderTest
```

### ptbx_until_test_fails_in_docker

Runs a `mvn test` command until it fails. The command is run within docker to limit CPU and memory resources.
This is supported only on a Linux host environment. 
Some flaky tests fail only when running on limited CPU resources.
Consider using [Multipass](https://multipass.run/) on Windows or macOS for running tests with limited resources.

Example of running `TopicReaderTest`
```
ptbx_until_test_fails_in_docker -Pcore-modules -pl pulsar-broker -Dtest=TopicReaderTest
```

### ptbx_until_test_fails_in_docker_with_logs

Similar as `ptbx_until_test_fails_in_docker`, but logs the output to a file.

Example of running `TopicReaderTest`
```
ptbx_until_test_fails_in_docker_with_logs -Pcore-modules -pl pulsar-broker -Dtest=TopicReaderTest
```


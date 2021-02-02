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

### ptbx_untilfail

Runs a command until it fails.
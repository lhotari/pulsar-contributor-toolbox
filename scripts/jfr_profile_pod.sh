#!/bin/bash
# script for jfr profiling the first java process in a pod
# Java Flight Recorder files can be analysed with Java Mission Control or Eclipse Mission Control.
# Download the Eclipse Mission Control flavor of jmc from https://adoptium.net/jmc
# Or install jmc with SDKMAN command "sdk i jmc"
if [[ $# -lt 1 ]]; then
    echo "usage: $0 --duration=[seconds] -n [namespace] [podname]"
    echo "example: $0 -n pulsar-testenv pod/pulsar-testenv-deployment-broker-0"
    exit 1
fi

duration=15
if [[ "$1" =~ --duration=([[:digit:]]+) ]]; then
    duration="${BASH_REMATCH[1]}"
    shift
fi

# create an inline script that is passed as a parameter to bash inside the container
read -r -d '' diag_script <<'EOF'
diagdir=$1
duration=${2:-15}
mkdir -p $diagdir

function jfr() {
  local pid=$1
  local COMMAND=$2
  if [ "$COMMAND" = "stop" ] || [ "$COMMAND" = "dump" ]; then
    local JFR_FILE=$diagdir/recording_$(date +%F-%H%M%S).jfr
    jcmd $pid JFR.$COMMAND name=recording filename=$JFR_FILE
  else
    jcmd $pid JFR.start name=recording settings=profile
  fi
}

javapid=$(pgrep java|head -1)
jfr $javapid start
echo "Waiting $duration seconds..."
sleep $duration
jfr $javapid stop
EOF

# run the script and provide the target directory inside the pod
diagdir=/tmp/diagnostics$$
#set -xe
kubectl exec "$@" -- bash -c "${diag_script}" -- $diagdir "$duration"
jfrfile="$(kubectl exec -q "$@" -- bash -c "cd $diagdir && tar zcf - * && rm -rf $diagdir" | tar zxvf -)"
echo -e "Java Flight Recorder files can be analysed with Java Mission Control or Eclipse Mission Control.\nDownload from https://adoptium.net/jmc\nYou can also install jmc with SDKMAN command 'sdk i jmc'\nUse this command to open the file:\njmc -open $PWD/$jfrfile"

#!/bin/bash
# script for collecting 3 threaddumps and 1 heapdump from all Java processes running inside a pod
# assumes that bash, pgrep, jstack and jmap commands are available in the container
if [[ $# -lt 1 ]]; then
    echo "usage: $0 -n [namespace] [podname]"
    echo "example: $0 -n pulsar-testenv pod/pulsar-testenv-deployment-broker-0"
    exit 1
fi

# create an inline script that is passed as a parameter to bash inside the container
read -r -d '' diag_script <<'EOF'
diagdir=$1
mkdir -p $diagdir
for i in 1 2 3; do
    # wait 3 seconds (if not the 1. round)
    [ $i -ne 1 ] && { echo "Waiting 3 seconds..."; sleep 3; }
    # iterate all java processes
    for javapid in $(pgrep java); do
        # on the first round, collect the full command line used to start the java process
        if [ $i -eq 1 ]; then
            java_commandline="$(cat /proc/$javapid/cmdline | xargs -0 echo)"
            echo "Collecting diagnostics for PID $javapid, ${java_commandline}"
            echo "${java_commandline}" > $diagdir/commandline_${javapid}.txt
            cat /proc/$javapid/environ | xargs -0 -n 1 echo > $diagdir/environment_${javapid}.txt
        fi
        # collect the threaddump with additional locking information
        echo "Creating threaddump..."
        jstack -l $javapid > $diagdir/threaddump_${javapid}_$(date +%F-%H%M%S).txt
        # collect a heap dump on 1. round
        if [ $i -eq 1 ]; then
            echo "Creating heapdump..."
            jmap -dump:format=b,file=$diagdir/heapdump_${javapid}_$(date +%F-%H%M%S).hprof $javapid
        fi
    done
done
EOF

# run the script and provide the target directory inside the pod
diagdir=/tmp/diagnostics$$
set -xe
kubectl exec "$@" -- bash -c "${diag_script}" -- $diagdir
diagnostics_file="jvm_diagnostics_$(date +%F-%H%M%S).tar.gz"
kubectl exec -q "$@" -- bash -c "cd $diagdir && tar zcf - * && rm -rf $diagdir" > "${diagnostics_file}"
echo "diagnostics information in ${diagnostics_file}"

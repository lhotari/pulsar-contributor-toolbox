#!/bin/bash
# script for collecting 3 threaddumps and 2 heapdumps from all Java processes running inside a docker container
# assumes that bash, jps, jstack and jmap commands are available in the container
container_id=$1
if [ -z "${container_id}" ]; then
    echo "usage: $0 [container_id]"
    exit 1
fi

# create an inline script that is passed as a parameter to bash inside the container
read -r -d '' diag_script <<'EOF'
diagdir=$1
mkdir $diagdir
# loop 3 times
for i in 1 2 3; do
    # wait 3 seconds (if not the 1. round)
    [ $i -ne 1 ] && { echo "Waiting 3 seconds..."; sleep 3; }
    # iterate all java processes
    for javapid in $(jps -q -J-XX:+PerfDisableSharedMem); do
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
        # collect a heap dump on 1. and 3. rounds
        if [ $i -ne 2 ]; then
            echo "Creating heapdump..."
            jmap -dump:format=b,file=$diagdir/heapdump_${javapid}_$(date +%F-%H%M%S).hprof $javapid        
        fi
    done
done
EOF

# run the script and provide the target directory inside the container as an argument
docker exec -i $container_id bash -c "${diag_script}" bash /tmp/diagnostics$$

# copy collected diagnostics from the container and remove files from the container
diagnostics_dir="jvm_diagnostics_${container_id}_$(date +%F-%H%M%S)"
docker cp $container_id:/tmp/diagnostics$$ ${diagnostics_dir} && docker exec $container_id rm -rf /tmp/diagnostics$$
echo "diagnostics information in $diagnostics_dir"
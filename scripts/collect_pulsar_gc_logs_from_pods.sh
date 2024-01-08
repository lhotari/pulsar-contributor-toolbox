#!/bin/bash
# script for collecting /pulsar/logs/pulsar_gc_*.log* files from multiple pods
# usage example: collect_pulsar_gc_logs_from_pods.sh -l "component in (broker,bookie,zookeeper)" -A
#                - this collects diagnostics from all Pulsar broker, bookie & zookeeper pods in any namespace
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
while read -r namespace name; do
    "$SCRIPT_DIR"/collect_pulsar_gc_logs_from_pod.sh -n "$namespace" "--field-selector=metadata.name=$name"
done < <(kubectl get "$@" pods --no-headers -o custom-columns=":metadata.namespace,:metadata.name")

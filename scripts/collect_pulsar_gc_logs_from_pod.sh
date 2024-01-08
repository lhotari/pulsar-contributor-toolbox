#!/bin/bash
# script for collecting /pulsar/logs/pulsar_gc_*.log* from a pod
if [[ $# -lt 1 ]]; then
    echo "usage: $0 -n [namespace] [podname]"
    echo "example: $0 -n pulsar-testenv pod/pulsar-testenv-deployment-broker-0"
    exit 1
fi
set -xe
{ read -r namespace podname; } < <(kubectl get "$@" pods --no-headers -o custom-columns=":metadata.namespace,:metadata.name" | head -n 1)
if [[ -z "$podname" ]]; then
    echo "no pods found"
    exit 1
fi
gc_logs_file="pulsar_gc_logs_${namespace}_${podname}_$(date +%F-%H%M%S).tar.gz"
kubectl exec -n "$namespace" pod/"$podname" -- bash -c "cd /pulsar/logs; tar zcvf - pulsar_gc_*.log*" > "${gc_logs_file}"
echo "GC logs collected to ${gc_logs_file}"

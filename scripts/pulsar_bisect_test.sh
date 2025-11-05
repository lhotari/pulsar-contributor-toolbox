#!/usr/bin/env -S bash -e
# A script to be used with 'git bisect run' to find a commit that introduced a test failure in Apache Pulsar.
# usage example:
# # Checkout the previous commit known to be good (such as previous release tag)
# git checkout v4.0.7
# # Check that the test passes on the good commit
# pulsar_bisect_test.sh -pl pulsar-broker -Dtest=org.apache.pulsar.broker.service.persistent.TopicDuplicationTest#testFinishTakeSnapshotWhenTopicLoading
# # Go back to the previous commit
# git checkout -
# # Start the bisect process
# git bisect start
# git bisect bad
# git bisect good v4.0.7
# git bisect run pulsar_bisect_test.sh -pl pulsar-broker -Dtest=org.apache.pulsar.broker.service.persistent.TopicDuplicationTest#testFinishTakeSnapshotWhenTopicLoading
# git bisect reset
#
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
. $SCRIPT_DIR/../functions/pulsar-contributor-toolbox-functions.sh
# Build the project
ptbx_build_coremodules -Dcheckstyle.skip=true -Dspotbugs.skip=true -Dlicense.skip=true || exit 125

# Run the test
ptbx_run_test "$@"
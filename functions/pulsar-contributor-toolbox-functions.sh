# shell functions for working with Pulsar development
# zsh and bash are supported

if [ -z "$PULSAR_CONTRIBUTOR_TOOLBOX" ]; then
  if [ -n "$BASH_SOURCE" ]; then
    PULSAR_CONTRIBUTOR_TOOLBOX=$(dirname $BASH_SOURCE)
  else
    # zsh
    PULSAR_CONTRIBUTOR_TOOLBOX=${0:a:h}
  fi
  PULSAR_CONTRIBUTOR_TOOLBOX=$(dirname $PULSAR_CONTRIBUTOR_TOOLBOX)
fi

# alias for refreshing changes
if [ -n "$BASH_SOURCE" ]; then
  alias ptbx_refresh="source $BASH_SOURCE"
else
  # zsh
  alias ptbx_refresh="source ${0:a}"
fi

# add bin directory to path
export PATH="$PULSAR_CONTRIBUTOR_TOOLBOX/bin:$PATH"




# runs a command until it fails
function ptbx_untilfail() {
  (
    while $@; do :; done
  )
}

# runs a command within docker to limit cpu and memory
function ptbx_docker_2cores_run() {
  docker run --cpus=2 --memory=6g -u $UID:$GID --net=host -it --rm -v $HOME:$HOME -w $PWD -v /etc/passwd:/etc/passwd:ro ubuntu "$@"
}

# runs tests with docker to limit cpu & memory, in a loop until it fails
# it is assumed that sdkman is used for JDK management. the default JDK version will be used within docker.
# example: ptbx_until_test_fails_in_docker -Pcore-modules -pl pulsar-broker -Dtest=TopicReaderTest
function ptbx_until_test_fails_in_docker() {
  (
    ptbx_docker_2cores_run \
    bash -c "source \$HOME/.sdkman/bin/sdkman-init.sh
    $(ptbx_until_test_fails_script)" "$@"
  )
}

function ptbx_until_test_fails_in_docker_with_logs() {
  (
    ptbx_until_test_fails_in_docker "$@" | ptbx_tee_to_output_log
  )
}

function ptbx_until_test_fails() {
  (
    bash -c "$(ptbx_until_test_fails_script)" "$@"
  )
}

function ptbx_until_test_fails_with_logs() {
  (
    ptbx_until_test_fails "$@" | ptbx_tee_to_output_log
  )
}

function ptbx_until_test_fails_script() {
  cat << 'EOF'
counter=1
while mvn -DredirectTestOutputToFile=false -DtestRetryCount=0 test "$@"; do
  echo "----------- LOOP $counter ---------------"
  ((counter++))
done
echo "Exited after loop #$counter"
EOF
}

function ptbx_tee_to_output_log() {
  tee "output_$(ptbx_datetime).log"
}

# prints a date & time up to second resolution
function ptbx_datetime() {
  date +%Y-%m-%d-%H%M%S
}

# changes the working directory to the Pulsar source code directory set by PULSAR_DEV_DIR
function ptbx_cd_pulsar_dir {
    if [ -n "$PULSAR_DEV_DIR" ]; then
        cd "$PULSAR_DEV_DIR"
    else
        GITDIR=$(git rev-parse --show-toplevel)
        [ ! -d "$GITDIR" ] && echo "Not a git directory" && return 1
        cd $GITDIR
    fi
}

# creates a local git working directory that can git pull from the actual working directory
# this is useful for running tests in the background
function ptbx_local_clone_create() {
  (
    set -e
    echo "setup local clone"
    GITDIR=$(git rev-parse --show-toplevel)
    [ ! -d "$GITDIR" ] && echo "Not a git directory" && exit 1
    local UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)
    UPSTREAM="${UPSTREAM:-origin/master}"
    CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    ORIGINNAME=$(dirname $UPSTREAM)
    ORIGINURL=$(git config --get remote.$ORIGINNAME.url)
    REPONAME=$(basename $GITDIR)
    parentdir=$(dirname $GITDIR)
    CLONEDIR="$parentdir/$REPONAME.testclone"
    cd $parentdir
    [ -d "$REPONAME.testclone" ] && echo "Clone already exists" && exit 1
    git clone -b $CURRENTBRANCH $GITDIR/.git $REPONAME.testclone
    cd $REPONAME.testclone
    git remote rename origin local
    git remote add $ORIGINNAME "$ORIGINURL"
    git fetch local
    git fetch $ORIGINNAME
    git branch --set-upstream-to $UPSTREAM
    git config receive.denyCurrentBranch ignore
    git config gc.auto 0
    echo "Clone created in $(pwd)"
    cd "$GITDIR"
    git remote add testclone "$CLONEDIR/.git"
  )
}

# changes to the "testclone" directory
function ptbx_local_clone_cd() {
  ptbx_cd_pulsar_dir
  CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
  REPONAME=$(basename $PWD)
  parentdir=$(dirname $PWD)
  CLONEDIR="$parentdir/$REPONAME.testclone"
  [ ! -d "$CLONEDIR" ] && ptbx_local_clone_create
  cd $CLONEDIR
}

# updates the testclone
function ptbx_local_clone_update() {
  (
    [[ "$1" == "1" ]] || ptbx_local_clone_cd
    local UPSTREAM="$2"
    git fetch local
    local update_needed=0
    git rev-parse --verify -q $CURRENTBRANCH >/dev/null || update_needed=1
    git diff --quiet $CURRENTBRANCH local/$CURRENTBRANCH || update_needed=1
    if [ $update_needed -eq 1 ]; then
      git checkout -B $CURRENTBRANCH local/$CURRENTBRANCH
      [ -z "$UPSTREAM" ] || git branch --set-upstream-to $UPSTREAM
      exit 0
    else
      echo "No changes."
      exit 1
    fi
  )
}

# pushes all changes to repository named "forked"
# useful when calling the github fork of a repository "forked"
function ptbx_gitpush_to_forked() {
  (
    CURRENTBRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name HEAD)
    if [ -n "$CURRENTBRANCH" ]; then
      git push -f forked "$CURRENTBRANCH:$CURRENTBRANCH"
    fi
  )
}

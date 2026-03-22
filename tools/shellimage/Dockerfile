FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
ARG NONINTERACTIVE=1
ARG USER_NAME=dev
ARG USER_ID=1000
ARG GROUP_NAME=mygroup
ARG GROUP_ID=1000
ARG HOME_DIR=/home/$USER_NAME
ENV CACHE_DIR=/var/cache/shellimage/$USER_NAME
ENV SDKMAN_DIR=$CACHE_DIR/sdkman
ENV GRADLE_USER_HOME=$CACHE_DIR/gradle
ENV MAVEN_CACHE=$CACHE_DIR/maven
RUN <<'EOS' /bin/bash
set -eux
set -o pipefail
apt-get update
apt-get dist-upgrade -y
apt-get install -y curl wget zip unzip wget ca-certificates \
  git tig locales netcat-openbsd jq docker.io vim procps htop \
  less netcat-openbsd dnsutils iputils-ping sudo tmux ripgrep build-essential
locale-gen en_US.UTF-8
groupadd -g $GROUP_ID $GROUP_NAME || true
mkdir -p $HOME_DIR
chown -R $USER_ID:$GROUP_ID $HOME_DIR
mkdir -p /home/linuxbrew
chown -R $USER_ID:$GROUP_ID /home/linuxbrew
cd $HOME_DIR
ln -s $MAVEN_CACHE .m2
useradd -M -d $HOME_DIR -u $USER_ID -g $GROUP_ID -s /bin/bash $USER_NAME
adduser $USER_NAME root
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$USER_NAME
chmod 0440 /etc/sudoers.d/$USER_NAME
mkdir -p $CACHE_DIR
chown -R $USER_ID:$GROUP_ID $CACHE_DIR
EOS
USER $USER_ID:$GROUP_ID
RUN <<'EOS' /bin/bash
set -ex
set -o pipefail
curl -s "https://get.sdkman.io" | bash
source $SDKMAN_DIR/bin/sdkman-init.sh
echo "sdkman_auto_answer=true" >> $SDKMAN_DIR/etc/config
sdk install java 17.0.18-amzn
sdk install maven
sdk install gradle
curl -LsSf https://astral.sh/uv/install.sh | sh
curl -fsSL https://claude.ai/install.sh | bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
cat >> ~/.bashrc << 'EOF'
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
EOF
source $HOME/.local/bin/env
uv python install 3.12
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
brew install gh
EOS
USER root
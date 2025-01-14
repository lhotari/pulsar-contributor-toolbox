# Vagrant Windows 11 box for testing Pulsar on Windows

## Prerequisites

- Linux host running on Intel/AMD CPU (not Apple Silicon)
- [Vagrant](https://www.vagrantup.com/)
- [VirtualBox](https://www.virtualbox.org/)

## First time usage

It's necessary to run `vagrant up` and `vagrant halt` once to install the Windows 11 box.

```shell
vagrant up
# shutdown the box
vagrant halt
```

## Usage

```shell
vagrant up
# login to the box, password is "vagrant"
vagrant ssh
# shutdown the box
vagrant halt
```

### Usage in Windows shell to build Pulsar

while in the `vagrant ssh` shell, you can build Pulsar with the following commands:

git, java and maven are installed as part of the provisioning script.

```shell
git clone https://github.com/apache/pulsar
cd pulsar
git fetch origin pull/<PR NUMBER>/merge
git checkout FETCH_HEAD
mvn clean install -DskipTests
```

## Troubleshooting

To start the box with GUI, run the following command:

```shell
vbgui=true vagrant up
```

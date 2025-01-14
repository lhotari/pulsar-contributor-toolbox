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

## Troubleshooting

To start the box with GUI, run the following command:

```shell
vbgui=true vagrant up
```

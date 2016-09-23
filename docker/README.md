# Duniter in a Docker container

### Running container from Docker Hub

#### 1. Create directory for data volume to persist config and data files
```
mkdir ~/duniter-data
```

#### 2. Configure Duniter and sync the blockchain

Without identity:

```
docker run --name duniter \
   -p 8999:8999 \
   -v ~/duniter-data/:/home/duser/.config \
   -e "DUNITER_URL=cgeek.fr" -e "DUNITER_PORT=9330" -e "DUNITER_INIT=yes" \
   --rm \
   -t ktorn/duniter
```

With your identity:

```
docker run --name duniter \
   -p 8999:8999 \
   -v ~/duniter-data/:/home/duser/.config \
   -e "DUNITER_URL=cgeek.fr" -e "DUNITER_PORT=9330" -e "DUNITER_INIT=yes" \
   -e "DUNITER_SALT=<your_key_salt>" -e "DUNITER_PASSWD=<your_passwd>" \
   --rm \
   -t ktorn/duniter
```

#### 3. Run Duniter Daemon

```
docker run --name duniter \
   -p 8999:8999 \
   -v ~/duniter-data/:/home/duser/.config \
   --restart always \
   -dt ktorn/duniter
```

To examine the daemon logs, from the host you can `tail -f ~/duniter-data/duniter/duniter_default/duniter.log`

#### Building your container

Download `Dockerfile` and `go` files in a repository.

```sh
docker build -t="duniter" .
```

Then run steps 1 through 3 above, replacing `ktorn/duniter` with `duniter`.

# @globules-io/cordovup

Global command that updates Cordova plugins in the project you run it from.

```bash
npm install -g @globules-io/cordovup
```

then run

```bash
cordovup
```

Run it in a Cordova project (the folder that contains `config.xml`).

1. Runs `npm outdated --depth=0`
2. Lists outdated plugins from that list that are declared in `config.xml`, then `all` and `none`
3. Saves each chosen `<plugin>` element, including its `<variable>` children
4. Runs `cordova plugin rm <name> --force` for each chosen plugin
5. Writes the saved elements back into `config.xml` with the latest version (a leading `^`, `~`, or range operator is kept)
6. Runs `cordova prepare`, which installs the plugins from `config.xml`

`cordova` and `npm` must be on your PATH.

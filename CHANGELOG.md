## [2.18.3](https://github.com/elohmeier/grafana-pi-app/compare/v2.18.2...v2.18.3) (2026-08-12)


### Bug Fixes

* support external assistant launch prompts ([fa18f4e](https://github.com/elohmeier/grafana-pi-app/commit/fa18f4effd69034576b23f0cd6c3737509fc0dcc))

## [2.18.2](https://github.com/elohmeier/grafana-pi-app/compare/v2.18.1...v2.18.2) (2026-08-12)


### Bug Fixes

* match official Grafana Assistant title in the variant packaging manifest ([926d67a](https://github.com/elohmeier/grafana-pi-app/commit/926d67a4df9266bff75d64f4c7f2db693912f2fb))

## [2.18.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.18.0...v2.18.1) (2026-08-12)


### Bug Fixes

* match official Grafana Assistant title for the grafana-assistant-app variant ([a1a1ea4](https://github.com/elohmeier/grafana-pi-app/commit/a1a1ea4dbbcbf5b1898b7ed3cac64ff0761b1389))

# [2.18.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.17.2...v2.18.0) (2026-08-10)


### Bug Fixes

* harden live dashboard mutation retries ([26adfba](https://github.com/elohmeier/grafana-pi-app/commit/26adfbaca77dde3dd25a360814a9af2d34bd78e6))
* improve assistant sidebar layout ([df4d0a2](https://github.com/elohmeier/grafana-pi-app/commit/df4d0a2c1482f09b740598364346565be8ef3d5a))
* improve specialist activity feedback ([1808159](https://github.com/elohmeier/grafana-pi-app/commit/1808159f5c2db00437cc12805ab19ddcbbd94b7b))
* preserve empty dashboard metric facts ([6c3e08b](https://github.com/elohmeier/grafana-pi-app/commit/6c3e08b7652901c5cabc01ac50ac068dd0891277))
* serialize live query variables for Grafana v2 ([fefb30c](https://github.com/elohmeier/grafana-pi-app/commit/fefb30cece11c31da1e4e2301e1deac196512bce))


### Features

* import custom skills into local provisioning ([6f0790e](https://github.com/elohmeier/grafana-pi-app/commit/6f0790e8d28c2f053354fa4a745e34d36f540a3d))
* import dashboard directory trees ([da15ad4](https://github.com/elohmeier/grafana-pi-app/commit/da15ad4b1955ce248e8d0249ffc71b93dd2d606b))

## [2.17.2](https://github.com/elohmeier/grafana-pi-app/compare/v2.17.1...v2.17.2) (2026-08-09)


### Bug Fixes

* bump vulnerable transitive dependencies ([7397e7d](https://github.com/elohmeier/grafana-pi-app/commit/7397e7d4d3a7473a9a4bb280feb81352f005c2fd))
* sync package-lock with js-cookie override for npm ci ([3f0d061](https://github.com/elohmeier/grafana-pi-app/commit/3f0d06113e84d0d60c839ec3db2849662e1e5b2c))

## [2.17.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.17.0...v2.17.1) (2026-08-09)


### Bug Fixes

* support OpenAI Responses API ([8e56c76](https://github.com/elohmeier/grafana-pi-app/commit/8e56c76bccaa0952db834c1264d33096e1fc875b))

# [2.17.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.16.0...v2.17.0) (2026-07-26)


### Bug Fixes

* auto-approve live dashboard edits ([c2262c3](https://github.com/elohmeier/grafana-pi-app/commit/c2262c3e5091384efc92a74305c6d3f869144889))


### Features

* **dashboard:** add batch query edits ([f80411f](https://github.com/elohmeier/grafana-pi-app/commit/f80411fd3261a082982dbceea3df2702b199c456))

# [2.16.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.15.1...v2.16.0) (2026-07-21)


### Features

* notify agent workspaces ([f05cfa2](https://github.com/elohmeier/grafana-pi-app/commit/f05cfa20494babfea1663e21ab718a34a53b2558))

## [2.15.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.15.0...v2.15.1) (2026-07-03)


### Bug Fixes

* improve tool rendering robustness ([45dd137](https://github.com/elohmeier/grafana-pi-app/commit/45dd1379be36c8b2fe348027c1224a76969bcac4))

# [2.15.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.14.2...v2.15.0) (2026-07-02)


### Features

* **agent:** harden dashboard planning ([1078f79](https://github.com/elohmeier/grafana-pi-app/commit/1078f79048ddbe2a6a4ffec18b9952ade92a83f2))

## [2.14.2](https://github.com/elohmeier/grafana-pi-app/compare/v2.14.1...v2.14.2) (2026-07-01)


### Bug Fixes

* **metrics:** support v2 dashboard specs ([2cb6413](https://github.com/elohmeier/grafana-pi-app/commit/2cb6413dc2e18452de9a9b9a741c4c32b7541194))

## [2.14.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.14.0...v2.14.1) (2026-07-01)


### Bug Fixes

* **alerting:** support v2 dashboard panels ([7bd72ca](https://github.com/elohmeier/grafana-pi-app/commit/7bd72ca2120b959145e776847de71fb9b895f2f6))

# [2.14.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.13.0...v2.14.0) (2026-07-01)


### Features

* **alerting:** add panel alert troubleshooting ([0db71a4](https://github.com/elohmeier/grafana-pi-app/commit/0db71a45c520dd0fc75ab8e11660ce1b5e992013))

# [2.13.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.12.0...v2.13.0) (2026-07-01)


### Features

* support generic workspace launches ([d9ebe34](https://github.com/elohmeier/grafana-pi-app/commit/d9ebe341de36bc6dfbbfbe27add13878b094fd79))

# [2.12.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.11.1...v2.12.0) (2026-07-01)


### Features

* add coding agent workspace sample ([f155f8a](https://github.com/elohmeier/grafana-pi-app/commit/f155f8a4d9dc1f2d971787aa7683283656085a58))

## [2.11.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.11.0...v2.11.1) (2026-06-30)


### Bug Fixes

* **chat:** stream subagent progress ([a99bfe6](https://github.com/elohmeier/grafana-pi-app/commit/a99bfe6560dd6845f9b6e6c8a3abcae75d56b1f4))
* compact live dashboard artifacts ([7e19115](https://github.com/elohmeier/grafana-pi-app/commit/7e191154f50063c20ad869611dfb9fd881e47346))
* retry transient Prometheus failures ([65a2c58](https://github.com/elohmeier/grafana-pi-app/commit/65a2c5839da30f2759ceb8df6e95892511650daa))

# [2.11.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.10.0...v2.11.0) (2026-06-30)


### Bug Fixes

* **chat:** show live stream progress ([e36ae45](https://github.com/elohmeier/grafana-pi-app/commit/e36ae45209280f913c21cf022d6746811757c1a0))
* preserve live dashboard edit context ([7da9d8e](https://github.com/elohmeier/grafana-pi-app/commit/7da9d8ec5597c38b678c01ab442d73a6e4738e4a))


### Features

* **chat:** improve save and session controls ([01cdf1c](https://github.com/elohmeier/grafana-pi-app/commit/01cdf1c571376a962b8e9f102a86eb69d2bcf2df))
* **sidebar:** add current page context ([3b20a97](https://github.com/elohmeier/grafana-pi-app/commit/3b20a97cc87c345da52a938c094d69d8cc485057))
* **telemetry:** expose assistant metrics ([7aa6f9b](https://github.com/elohmeier/grafana-pi-app/commit/7aa6f9bdf86957b999823b55e2819a024f417a69))

# [2.10.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.9.0...v2.10.0) (2026-06-30)


### Features

* add custom skills configuration editor ([f0fe127](https://github.com/elohmeier/grafana-pi-app/commit/f0fe127f006f03dabbd9a60c55b4fff4ecc4ce36))

# [2.9.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.8.1...v2.9.0) (2026-06-29)


### Features

* improve dashboard Jsonnet tooling ([ede77a2](https://github.com/elohmeier/grafana-pi-app/commit/ede77a2c5374030d842617f4704e1ad95b2c8fd1))

## [2.8.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.8.0...v2.8.1) (2026-06-28)


### Bug Fixes

* render live tool results ([441d648](https://github.com/elohmeier/grafana-pi-app/commit/441d6486ceeb31fe9bb1629043c6280aae16cbac))

# [2.8.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.7.0...v2.8.0) (2026-06-28)


### Features

* add dashboard assistant editing ([22bf556](https://github.com/elohmeier/grafana-pi-app/commit/22bf5569eb9feb210eb15342f1489b099791bcd9))
* add dashboard metric discovery ([77577c5](https://github.com/elohmeier/grafana-pi-app/commit/77577c50bb0e598d8e01937f2ddae3922514aae7))

# [2.7.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.6.1...v2.7.0) (2026-06-28)


### Features

* add assistant sidebar variant ([db044e2](https://github.com/elohmeier/grafana-pi-app/commit/db044e28e0d310740c1a182f0807334e11e64e41))

## [2.6.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.6.0...v2.6.1) (2026-06-28)


### Bug Fixes

* **chat:** guard dirty navigation ([1ecdd50](https://github.com/elohmeier/grafana-pi-app/commit/1ecdd50123ec3c49c498414cef11cc5cd3a2d707))

# [2.6.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.5.3...v2.6.0) (2026-06-25)


### Features

* update Assistant UI defaults ([006f6c9](https://github.com/elohmeier/grafana-pi-app/commit/006f6c9b732bfd3e4496046d05a5d93a990fc260))

## [2.5.3](https://github.com/elohmeier/grafana-pi-app/compare/v2.5.2...v2.5.3) (2026-06-24)


### Bug Fixes

* expose selected chat skill tools ([f3c9110](https://github.com/elohmeier/grafana-pi-app/commit/f3c9110de944e05eb32ab207cde5cc400879ebbc))

## [2.5.2](https://github.com/elohmeier/grafana-pi-app/compare/v2.5.1...v2.5.2) (2026-06-24)


### Bug Fixes

* prevent mobile session title clipping ([bd5945c](https://github.com/elohmeier/grafana-pi-app/commit/bd5945c03f7aaeae8aa6557d91bdb1bd94d54cc9))

## [2.5.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.5.0...v2.5.1) (2026-06-05)

### Bug Fixes

- **chat:** handle stopped chat replay content ([2db3ccf](https://github.com/elohmeier/grafana-pi-app/commit/2db3ccfbd1e2b0cd9c0e00ed9f619b5edcb1f4a4))

# [2.5.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.4.1...v2.5.0) (2026-06-05)

### Features

- **chat:** replace dashboard bootstrap ([7cf7ac8](https://github.com/elohmeier/grafana-pi-app/commit/7cf7ac8040f422cf6e2a335ab6bd788d18aa6618))

## [2.4.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.4.0...v2.4.1) (2026-06-05)

### Bug Fixes

- **chat:** improve artifact tool renderers ([c8538b9](https://github.com/elohmeier/grafana-pi-app/commit/c8538b917717c6dbf2241c399af4b34b29a49af1))
- render nested Prometheus tool panels ([aab6a8c](https://github.com/elohmeier/grafana-pi-app/commit/aab6a8cfb5e102c6731cbe81476aad913c4b4f50))

# [2.4.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.3.0...v2.4.0) (2026-06-05)

### Features

- **chat:** add artifact registry ([b87ddb6](https://github.com/elohmeier/grafana-pi-app/commit/b87ddb6f6a44d33cb98591d2c15abfd1608b3383))

# [2.3.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.2.2...v2.3.0) (2026-06-05)

### Features

- add assistant safety workflows ([c1d89d2](https://github.com/elohmeier/grafana-pi-app/commit/c1d89d293b2f65d9b6c04f2c244b922faea4bb48))
- add bootstrap tool ([67e9915](https://github.com/elohmeier/grafana-pi-app/commit/67e9915446e915df34b4af8a76a948846ae2aa22))
- add configurable model thinking ([0d9871b](https://github.com/elohmeier/grafana-pi-app/commit/0d9871b19713dae1986d9e3cdb070482ad6dceb3))
- add dashboard design subagent ([117a169](https://github.com/elohmeier/grafana-pi-app/commit/117a169e5a7c8d38c3e21a9b7aaeaff396fc69f3))

## [2.2.2](https://github.com/elohmeier/grafana-pi-app/compare/v2.2.1...v2.2.2) (2026-06-03)

### Bug Fixes

- improve tool renderer & error handling ([3578bdd](https://github.com/elohmeier/grafana-pi-app/commit/3578bdd4fcdae15fc10b1d466dcbd01c4ed47bc8))

## [2.2.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.2.0...v2.2.1) (2026-05-29)

### Reverts

- Revert "feat: add InfluxDB query support" ([72234b3](https://github.com/elohmeier/grafana-pi-app/commit/72234b352db90cfd197ee296cb2ce27d54b21325))

# [2.2.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.1.0...v2.2.0) (2026-05-29)

### Features

- add InfluxDB query support ([dd154f4](https://github.com/elohmeier/grafana-pi-app/commit/dd154f46a714d0bda0b625d970bb7283e56e92fd))

# [2.1.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.0.0...v2.1.0) (2026-05-29)

### Features

- add configurable app access ([db4068f](https://github.com/elohmeier/grafana-pi-app/commit/db4068fcfcca259eb056e1aeb0dd5811fc4b2faa))

# [2.0.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.3.0...v2.0.0) (2026-05-29)

- refactor(chat)!: rename Prometheus allowlist ([bacd322](https://github.com/elohmeier/grafana-pi-app/commit/bacd3226188a8a225967f58a21082d60c295765d))

### BREAKING CHANGES

- allowedDatasourceUids is no longer read. Use allowedPrometheusDatasourceUids.

# [1.3.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.2.0...v1.3.0) (2026-05-29)

### Features

- **config:** add system prompt addendum ([30e07fb](https://github.com/elohmeier/grafana-pi-app/commit/30e07fbcddad06eca7e952343a0bfeeaf87eb2e4))
- **skills:** add configurable custom skills ([1b76806](https://github.com/elohmeier/grafana-pi-app/commit/1b76806be3532575b42b1a3ab475f2ccbab66c74))

# [1.2.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.1.0...v1.2.0) (2026-05-29)

### Features

- analysis bench / skills ([cbe2656](https://github.com/elohmeier/grafana-pi-app/commit/cbe265650d484d156b2bc9ff0463fa68934ebce3))
- icons ([4e56110](https://github.com/elohmeier/grafana-pi-app/commit/4e56110278b48675a1326afa7a665ea5987cc357))
- rename & tool rendering & export ([7c33103](https://github.com/elohmeier/grafana-pi-app/commit/7c33103fa7f3db82e769d3a577f73f9b11181ca8))

# [1.1.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.0.1...v1.1.0) (2026-05-28)

### Features

- render ([8afcab5](https://github.com/elohmeier/grafana-pi-app/commit/8afcab5d31fadda81fc71047348ce5dc2440e18d))

## [1.0.1](https://github.com/elohmeier/grafana-pi-app/compare/v1.0.0...v1.0.1) (2026-05-28)

### Bug Fixes

- omit LLM metadata from upstream requests ([0c8091b](https://github.com/elohmeier/grafana-pi-app/commit/0c8091b97601f57e35fb702963dc147b032bc06b))

# 1.0.0 (2026-05-28)

### Features

- add Grafana Pi app ([666cc42](https://github.com/elohmeier/grafana-pi-app/commit/666cc42c064fac195ea45cf0f8429a639359f69d))
- add release publishing ([8cb83da](https://github.com/elohmeier/grafana-pi-app/commit/8cb83dad16e91fae103de45f170fc3ab287ceb35))

# Changelog

# MET Norway test data

This is what the weather app's tests use: replies from MET Norway's Locationforecast 2.0 (`compact`). `test/agentv/fixtures/record/met` recorded them in CI on 2026-10-25. Each file keeps the reply and the headers the app reads.

The forecasts are MET Norway's data, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). `zone.tab` is a few lines of the tz database's, which is public domain.

To record new replies, push a branch called `record/<anything>`. The Record fixtures workflow pushes fresh ones back to it.

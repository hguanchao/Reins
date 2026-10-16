#!/usr/bin/env node
import { main } from "./bootstrap.ts";

process.exitCode = await main(process.argv.slice(2));

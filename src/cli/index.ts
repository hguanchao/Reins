#!/usr/bin/env node
import { main } from "./bootstrap.ts";

process.exitCode = main(process.argv.slice(2));

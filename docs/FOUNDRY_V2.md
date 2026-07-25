# Reactor Foundry v2

## Architecture Overview
A builder-pattern based build system that replaces the monolithic `run_foundry_build_worker` function from reactor_foundry.rs. The new design uses a trait-based plugin system where each build phase (Clone, Configure, Build, Publish, Rollback) implements the `FoundryPhase` trait.

## Module Structure
- `mod.rs` — Core types: FoundryBuildConfig, FoundryBuildConfigBuilder, BuildPhase enum, BuildPipeline
- `phases.rs` — Phase implementations: ClonePhase, ConfigurePhase, BuildPhase, PublishPhase, RollbackPhase
- `tests.rs` — Unit test coverage for builder pattern and phase trait contracts

## Migration from v1
v1's 900-line `run_foundry_build_worker` is decomposed into discrete phases. Each phase is independently testable and swappable. The BuildPipeline orchestrates phase execution sequentially.

## API
- `FoundryBuildConfigBuilder` — Fluent builder for constructing build configurations
- `BuildPipeline::advance()` — Moves to the next phase in the sequence
- `FoundryPhase::execute()` — Runs a single phase with the given config

## TypeScript Bindings
Frontend types are defined in `src/types/foundryV2.d.ts` with FoundryBuildConfig, BuildPhase, PhaseEvent, and BuildProgress interfaces.

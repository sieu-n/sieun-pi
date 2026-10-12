# Design red flags

Screen every candidate before synthesis. A red flag is a reason to revise or reject the shape.

## Shallow module

A shallow module has a large interface and hides little complexity. Judge depth by how much capability and policy sit behind the public interface, relative to its size.

A deep module differs from a deep call chain. A deep call chain spreads understanding across layers. A deep module puts capability behind one interface.

Look for these signs:

- Callers call several methods to complete one operation.
- Public options expose internal stages or implementation choices.
- Learning the interface does not spare the caller from learning the implementation.

## Information leakage

Leakage makes several modules depend on one internal decision. A representation, policy, or protocol detail appears in more than one place, so a change to it needs coordinated edits.

A public re-export of a transport or wire type is leakage. Parse external data into domain types behind the interface. Keep storage schemas, framework objects, and protocol details private.

## Temporal decomposition

Temporal decomposition splits modules by execution order instead of by the knowledge they own. Separate load, validate, transform, and save stages often repeat one representation and its invariants across several boundaries.

Group code by the knowledge it owns. Methods that run at different times belong in one module when they protect the same decisions.

## Pass-through method

A pass-through method forwards the same arguments to another method with the same shape. It adds a layer and hides nothing.

Remove it, or move the responsibility to the module that can complete the operation. Keep a forwarding layer only when it adds policy, adaptation, or a distinct abstraction.

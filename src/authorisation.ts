export interface ButtonLocation {
  readonly page: number;
  readonly row: number;
  readonly column: number;
}

const MINT = Symbol('companion-editor-mcp.write-authorisation');

type Target =
  | { readonly kind: 'button'; readonly location: ButtonLocation }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'connection'; readonly id: string }
  | { readonly kind: 'surfaces' }
  | { readonly kind: 'pages' }
  /** controlId null means a new trigger that has no id yet. */
  | { readonly kind: 'trigger'; readonly controlId: string | null };

/**
 * Proof that the safety layer approved exactly one write target.
 * Only safety.ts holds the mint key, so only it can construct one.
 */
export class WriteAuthorisation {
  readonly #target: Target;

  constructor(key: symbol, target: Target) {
    if (key !== MINT) {
      throw new Error('WriteAuthorisation can only be minted by the safety layer');
    }
    this.#target = target;
  }

  coversButton(loc: ButtonLocation): boolean {
    const t = this.#target;
    return (
      t.kind === 'button' &&
      t.location.page === loc.page &&
      t.location.row === loc.row &&
      t.location.column === loc.column
    );
  }

  coversVariable(name: string): boolean {
    return this.#target.kind === 'variable' && this.#target.name === name;
  }

  coversConnection(id: string): boolean {
    return this.#target.kind === 'connection' && this.#target.id === id;
  }

  coversSurfaces(): boolean {
    return this.#target.kind === 'surfaces';
  }

  coversPages(): boolean {
    return this.#target.kind === 'pages';
  }

  coversTrigger(controlId: string | null): boolean {
    return this.#target.kind === 'trigger' && this.#target.controlId === controlId;
  }
}

/** Imported by safety.ts only. */
export const mintKey: symbol = MINT;

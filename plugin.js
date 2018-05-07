
'use strict';

const assert = require('assert');

const babylon = require('babylon');
const template = require('babel-template');
const generate = require('babel-generator').default;
const t = require('babel-types');

function defaultGet( key, defaultConstructor ) {
	if( this.has(key) ) {
		return this.get( key );
	} else {
		const value = defaultConstructor( key );
		this.set( key, value );
		return value;
	}
}

// a namespace where we're gonna look for symbols
// it must be composed by at least one expression used in a `use traits * from` statement.
class TraitNamespace {
	constructor( path ) {
		assert( path.node.type === 'LabeledStatement' );
		assert( path.parent.type === 'BlockStatement' || path.parent.type === 'Program', `"use traits * from" must be placed in a block, or in the outermost scope.` );

		this.path = path;
		this.blockPath = path.parentPath;
		this.providers = new Set();
		this.symbols = new Map();

		this.addProvider( path );
	}

	addProvider( path ) {
		this.providers.add( path );

		if( ! path.node.body.expression ) {
			throw path.buildCodeFrameError(`"use traits * from" requires an expression.`);
		}
	}

	provideSymbol( symName ) {
		if( this.symbols.has(symName) ) {
			return this.symbols.get(symName);
		}
		const newSymbolIdentifier = this.blockPath.scope.generateUidIdentifier( symName );
		this.symbols.set( symName, newSymbolIdentifier );
		return newSymbolIdentifier;
	}

	finalize( getSymbolIdentifier ) {
		const providingExpressions =  Array.from(this.providers).map( p=>p.node.body.expression );

		if( ! this.symbols.size ) {
			return;
		}

		this.path.insertBefore(
			t.variableDeclaration(
				`const`,
				Array.from(this.symbols.entries()).map( ([name, id])=>{
					return t.variableDeclarator(
						id,
						t.callExpression(
							getSymbolIdentifier,
							[
								t.stringLiteral(name),
								...providingExpressions,
							]
						)
					);
				})
			)
		);
	}
	remove() {
		this.path.remove();
	}
}

function finalCheck( path ) {
	// making sure that no `_Straits` was left unresolved
	path.traverse({
		Identifier( path ) {
			if( path.node.name === `_Straits` ) {
				throw path.buildCodeFrameError(`.* used, without using any traits.`);
			}
		}
	});
}

module.exports = function( arg ) {
	return {
		visitor: {
			Program( path, state ) {
				const traitNamespaces = new Map();
				const getSymbolIdentifier = path.scope.generateUidIdentifier(`getSymbol`);

				// 1. marking all the blocks that contain a `_StraitsProvider` expression, and removing those.
				path.traverse({
					LabeledStatement( path ) {
						const node = path.node;
						if( node.label.name !== '_StraitsProvider' ) {
							return;
						}

						assert( path.parent.type === 'BlockStatement' || path.parent.type === 'Program', `"use traits * from" must be placed in a block, or in the outermost scope.` );

						const traitNS = defaultGet.call( traitNamespaces, path.parentPath, ()=>new TraitNamespace(path) );
						traitNS.addProvider( path );
					}
				});


				// if we didn't find any `use traits * from` statements, we can return
				// TODO: actually, we should fix `.*` anyways, but I'll code that that another day :P
				if( traitNamespaces.size === 0 ) {
					finalCheck( path ); // making sure that everythign is fine
					return;
				}

				// if we found at least one `use traits * from` statement, let's generate the `getSymbol` function
				const getSymbolBuilder = template(`
function GET_SYMBOL( targetSymName, ...symbolSets ) {
	let symbol;
	symbolSets.forEach( symbolSet=>{
		if( typeof symbolSet[targetSymName] === 'symbol' ) {
			if( !! symbol ) {
				throw new Error(\`Symbol \${targetSymName} offered by multiple symbol sets.\`);
			}
			symbol = symbolSet[targetSymName];
		}
	});
	if( ! symbol ) {
		throw new Error(\`No symbol set is providing symbol \${targetSymName}.\`);
	}
	return symbol;
}
				`)

				path.unshiftContainer('body', getSymbolBuilder({ GET_SYMBOL:getSymbolIdentifier }) );

				// 2. for each `use traits * from ...` expression we found, let's iterate backwards: if we see that some other `use traits * from ...` was defined in a higher scope, let's apply that expression here as well
				for( const [blockPath, traitNS] of traitNamespaces ) {
					let parentPath = blockPath.parentPath;
					while( parentPath ) {
						if( traitNamespaces.has(parentPath) ) {
							traitNamespaces.get(parentPath).providers.forEach( p=>{
								traitNS.addProvider( p );
							});
						}

						parentPath = parentPath.parentPath;
					}
				}

				// 3. for each `use traits * from ...` expression we found, let's find all the traits used within them (stuff after `.*`)
				//    instead of `.*` we'll find `._Straits.`: let's also remove that bit
				for( const [blockPath, traitNS] of traitNamespaces ) {
					blockPath.traverse({
						BlockStatement( subBlock ) {
							if( traitNamespaces.has(subBlock) ) {
								subBlock.skip();
							}
						},
						Identifier( path ) {
							const node = path.node;
							if( node.name !== '_Straits' ) {
								return;
							}

							// parentPath is the `(...)._Straits` expression
							// symbolPath is the `(...).${symbol}` one
							const parentPath = path.parentPath;
							let symbolPath;
							{
								const parent = parentPath.node;
								assert( parent.type === 'MemberExpression' );
								assert( parent.computed === false );

								const prop = parent.property;
								assert( prop === node );

								symbolPath = parentPath.parentPath;
							}

							{
								const symbolParent = symbolPath.node;
								assert( symbolParent.type === 'MemberExpression' );
								assert( symbolParent.object === parentPath.node );
							}

							/*
							// removing the `._Straits` part
							{
								parentPath.replaceWith(
									parentPath.node.object
								);
							}
							*/

							// fixing the cases where the original code was not `(...).*${symbol}`, but something else, like `.*(x.y)`
							if( symbolPath.node.computed ) {
								parentPath.replaceWith( parentPath.node.object );
								return;
							}

							// generating a new unique identifier for the symbol, and replacing the current symbol id with it:
							// from `(...).${symbolName}` to `(...)[${newSymbolName}]`
							const prop = symbolPath.node.property;
							const newSymbolIdentifier = traitNS.provideSymbol( prop.name );
							symbolPath.replaceWith(
								t.memberExpression(
									parentPath.node.object,
									newSymbolIdentifier,
									true
								)
							);
						}
					});
				}

				for( const traitNS of traitNamespaces.values() ) {
					traitNS.finalize( getSymbolIdentifier );
				}
				for( const traitNS of traitNamespaces.values() ) {
					traitNS.remove();
				}

				// turning `_Straits` within strings into `.*`
				// NOTE: if a string had `_Straits` originally, that'd be screwed up, escape those, maybe?
				function cleanString( str ) {
					return str
						.replace(/\._Straits\.?/g, `.*` )
						.replace(/_StraitsProvider:/g,  `use traits * from` );
				}
				path.traverse({
					StringLiteral( literalPath ) {
						const str = literalPath.node.value;
						const newStr = cleanString( str );
						if( newStr === str ) {
							return;
						}

						literalPath.replaceWith(
							t.stringLiteral(
								newStr
							)
						);
					},
					TemplateElement( elementPath ) {
						const {value, tail} = elementPath.node;
						const newValue = {
							raw: cleanString( value.raw ),
							cooked: cleanString( value.cooked ),
						};
						if( newValue.raw === value.raw || newValue.cooked === value.cooked ) {
							return;
						}

						elementPath.replaceWith(
							t.templateElement(
								newValue,
								tail
							)
						);
					},
				});

				finalCheck( path ); // making sure that everythign is fine
			}
		}
	};
};

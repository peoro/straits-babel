
const symbols1 = {
	one: Symbol(`one`),
};
const symbols2 = {
	two: Symbol(`two`),
};
const symbolsV = {
	value: Symbol(`value`),
};

use traits * from symbols1;
use traits * from symbols2;
use traits * from symbolsV;

class One {}
One.prototype.*one = ()=>1;
One.prototype.*value = function(){ return this.*one(); };

class Two {}
Two.prototype.*two = ()=>2;
Two.prototype.*value = function(){ return this.*two(); };

main( ()=>{
	const one = new One();
	const two = new Two();

	return one.*value() + two.*value();
});

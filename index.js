// For bundlers: `import Minilop from 'minilop'`. Same SDK as the <script> tag.
import './minilop.js';

export default typeof window === 'undefined' ? undefined : window.Minilop;

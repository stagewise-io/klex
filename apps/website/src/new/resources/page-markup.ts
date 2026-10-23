import { headerMarkup } from '../navigation';
import { footerMarkup } from '../sections/footer';
import { brandMarkup, pressMarkup } from './resources';

export const resourceMarkup = (
  isPress: boolean,
) => `${headerMarkup}  <main id="main" class="resource-main">
    ${isPress ? pressMarkup : brandMarkup}
  </main>
  ${footerMarkup}
`;

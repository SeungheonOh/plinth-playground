{-# LANGUAGE DataKinds #-}
{-# LANGUAGE TypeOperators #-}
module Main where

import Plutarch.Browser (exportScript)
import Plutarch.Internal.Term (compile)
import Plutarch.Prelude

successor :: Term s (PInteger :--> PInteger)
successor = plam $ \value -> value + 1

main :: IO ()
main = exportScript "BrowserPlutarch" $ compile mempty successor

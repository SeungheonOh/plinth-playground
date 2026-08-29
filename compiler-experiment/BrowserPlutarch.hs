{-# LANGUAGE DataKinds #-}
{-# LANGUAGE RankNTypes #-}
{-# LANGUAGE TemplateHaskell #-}
{-# LANGUAGE TypeOperators #-}
module Main where

import Plutarch.Browser (dumpScript)
import Plutarch.Internal.Term (compile)
import Plutarch.Prelude

$(dumpScript "BrowserPlutarch" $
    compile mempty $
      (plam (\value -> value + 1) ::
        forall s. Term s (PInteger :--> PInteger)))

main :: IO ()
main = pure ()
